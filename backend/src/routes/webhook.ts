import { Hono } from 'hono';
import { db, withTransaction } from '../db/index.ts';
import { items, users } from '../db/schema.ts';
import { itemByRatingKey, userByLocalAccountId, userByUsername } from '../db/scope.ts';
import { getActiveServer } from '../lib/plex.ts';
import type { PlexWebhookPayload } from '../lib/plex.ts';
import { networkKeyForIp } from '../lib/network.ts';
import { UNKNOWN_USERNAME_PLACEHOLDER } from '../lib/plexUsers.ts';

// media.play  — fires immediately on playback start; stamps lastViewedAt = now for real-time feel
// media.scrobble — fires at 90% watched; carries Plex's authoritative viewCount increment
const HANDLED_EVENTS = new Set(['media.play', 'media.scrobble']);

const router = new Hono();

router.post('/plex', async (c) => {
  const form = await c.req.formData();
  const raw = form.get('payload');
  if (typeof raw !== 'string') return c.json({ error: 'missing payload' }, 400);

  let payload: PlexWebhookPayload;
  try {
    payload = JSON.parse(raw) as PlexWebhookPayload;
  } catch {
    return c.json({ error: 'invalid payload' }, 400);
  }

  const { Metadata } = payload;
  if (!HANDLED_EVENTS.has(payload.event) || !Metadata?.ratingKey) return c.json({ ok: true });

  // Webhooks fire per-server — only apply updates that belong to the currently active
  // server, identified
  // by Plex's stable per-install uuid (payload.Server.uuid === servers.machineIdentifier).
  // A webhook from a server you've since disconnected/switched away from is ignored.
  const active = await getActiveServer();

  if (!active) {
    console.warn(
      `webhook ${payload.event}: no active server resolved yet — dropping update (server=${payload.Server?.uuid})`,
    );
    return c.json({ ok: true });
  }
  if (active.machineIdentifier !== payload.Server?.uuid) {
    console.warn(
      `webhook ${payload.event}: from server ${payload.Server?.uuid}, but active server is ${active.machineIdentifier} — dropping update`,
    );
    return c.json({ ok: true });
  }
  const serverId = active.serverId;

  const now = Math.floor(Date.now() / 1000);
  const isScrobble = payload.event === 'media.scrobble';
  const isEpisode = Metadata.type === 'episode';

  // For episodes, update the parent show row. Episode ratingKeys are not stored
  // in items — only show-level rows are, so we must use grandparentRatingKey.
  const itemKey = isEpisode ? Metadata.grandparentRatingKey : Metadata.ratingKey;
  if (!itemKey) {
    console.warn(
      `webhook ${payload.event}: episode missing grandparentRatingKey — skipping DB update`,
    );
    return c.json({ ok: true });
  }

  const updated = await db
    .update(items)
    .set({
      lastViewedAt: now,
      updatedAt: now,
      // viewCount on episodes reflects that episode only, not the show total — skip it.
      ...(!isEpisode && isScrobble && Metadata.viewCount != null
        ? { viewCount: Metadata.viewCount }
        : {}),
    })
    .where(itemByRatingKey(serverId, itemKey))
    .returning({ ratingKey: items.ratingKey });

  if (updated.length === 0) {
    console.warn(
      `webhook ${payload.event}: ${
        isEpisode ? 'show' : 'item'
      } ratingKey ${itemKey} not in DB — sync first`,
    );
  }

  // payload.Account.id is the PMS-LOCAL account id, not the global plex.tv id that
  // users.accountId (the roster's primary key) uses — see users.localAccountId in
  // schema.ts. Try the direct local-id match first (the common case once a full sync
  // has reconciled it); if that touches nothing, fall back to a username match and
  // backfill localAccountId at the same time, self-healing the mapping for an account
  // seen here before syncUsers() ever reconciled it. If neither matches, this account
  // has no roster row yet at all (e.g. the very first webhook before any full sync) —
  // skipped rather than inserted, since a webhook alone never carries the global id a
  // new row's primary key would need; the next full sync creates it instead.
  // id 0 is Plex's nameless/system placeholder (see PlexClient.localAccounts()'s same
  // exclusion in plex.ts) and is never a real account worth tracking activity for.
  //
  // lastViewedAt/lastPlayer are written unconditionally on every matched event — they
  // mean "most recent activity, from anywhere," independent of whether Plex counted
  // this particular event as a real play. totalPlays/totalDuration are the opposite:
  // scrobble-gated only, mirroring items.viewCount's existing scrobble-only gating
  // above, so a play that's started but abandoned doesn't inflate either counter.
  // IP handling is separate again: a genuine location change appends a history row,
  // while another event from the current IP refreshes that transition's lastSeenAt.
  // This retains recent evidence for a sharing detector without growing the table for
  // every play. The last-IP change and history write are committed atomically below.
  // User-level activity includes personal network data, so never accept it from an
  // unauthenticated endpoint. Item-level updates above remain available for existing
  // installs that intentionally run without a secret.
  if (payload.Account?.id != null && payload.Account.id !== 0) {
    // Resolve to a single roster row by primary key before writing anything — neither
    // local_account_id nor username is guaranteed unique in the schema (see
    // users_local_account_idx and the missing username constraint), so an UPDATE scoped
    // directly to either predicate risks silently touching more than one row if a
    // collision ever occurs (e.g. two friends both falling back to plexUsers.ts's
    // UNKNOWN_USERNAME_PLACEHOLDER). Ambiguous matches are skipped rather than guessed
    // at. The placeholder itself is never used as a fallback match target — by
    // definition it's not unique to one account, so an early single "match" against it
    // (before a second placeholder-having account has even synced yet) would silently
    // misattribute this account's activity with no way to unwind it once the collision
    // becomes visible.
    let candidates = await db.select({ accountId: users.accountId })
      .from(users)
      .where(userByLocalAccountId(serverId, payload.Account.id));

    let backfillLocalId = false;
    if (
      candidates.length === 0 && payload.Account.title &&
      payload.Account.title !== UNKNOWN_USERNAME_PLACEHOLDER
    ) {
      candidates = await db.select({ accountId: users.accountId })
        .from(users)
        .where(userByUsername(serverId, payload.Account.title));
      backfillLocalId = true;
    }

    if (candidates.length === 1) {
      const accountId = candidates[0].accountId;
      const ip = payload.Player?.publicAddress || null;
      withTransaction((client) => {
        const current = client.prepare(
          `SELECT last_ip, last_scrobbled_at FROM users
           WHERE server_id = ? AND account_id = ?`,
        ).get(serverId, accountId) as {
          last_ip: string | null;
          last_scrobbled_at: number | null;
        } | undefined;
        if (!current) return;

        // A scrobble without Plex's stable timestamp cannot be made idempotent, so it
        // still updates recent activity but does not alter lifetime aggregates.
        const scrobbleAt = isScrobble ? Metadata.lastViewedAt ?? null : null;
        const countScrobble = scrobbleAt !== null &&
          (current.last_scrobbled_at === null || scrobbleAt > current.last_scrobbled_at);
        client.prepare(
          `UPDATE users SET
             last_viewed_at = ?,
             last_player = coalesce(?, last_player),
             local_account_id = coalesce(?, local_account_id),
             total_plays = total_plays + ?,
             total_duration = total_duration + ?,
             last_scrobbled_at = coalesce(?, last_scrobbled_at)
           WHERE server_id = ? AND account_id = ?`,
        ).run(
          now,
          payload.Player?.title ?? null,
          backfillLocalId ? payload.Account.id : null,
          countScrobble ? 1 : 0,
          countScrobble ? Metadata.duration ?? 0 : 0,
          countScrobble ? scrobbleAt : null,
          serverId,
          accountId,
        );

        client.prepare(
          `INSERT INTO user_play_observations
             (server_id, account_id, observed_at, event, ip, network_key, player_uuid,
              player_title, is_local)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          serverId,
          accountId,
          now,
          payload.event,
          ip,
          networkKeyForIp(ip),
          payload.Player?.uuid ?? null,
          payload.Player?.title ?? null,
          payload.Player?.local == null ? null : Number(payload.Player.local),
        );

        if (ip !== null) {
          if (current.last_ip !== ip) {
            client.prepare(
              'UPDATE users SET last_ip = ? WHERE server_id = ? AND account_id = ?',
            ).run(ip, serverId, accountId);
            client.prepare(
              `INSERT INTO user_ip_history
                 (server_id, account_id, ip, viewed_at, last_seen_at)
               VALUES (?, ?, ?, ?, ?)`,
            ).run(serverId, accountId, ip, now, now);
          } else {
            client.prepare(
              `UPDATE user_ip_history SET last_seen_at = ?
               WHERE id = (
                 SELECT id FROM user_ip_history
                 WHERE server_id = ? AND account_id = ? AND ip = ?
                 ORDER BY viewed_at DESC, id DESC LIMIT 1
               )`,
            ).run(now, serverId, accountId, ip);
          }
        }
      });
    } else if (candidates.length > 1) {
      console.warn(
        `webhook ${payload.event}: ${candidates.length} accounts matched account=${payload.Account.id} title="${payload.Account.title}" — ambiguous, skipping activity update`,
      );
    }
  }

  return c.json({ ok: true });
});

export default router;
