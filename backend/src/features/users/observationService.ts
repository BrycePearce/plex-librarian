import { db, withTransaction } from '../../db/index.ts';
import { users } from '../../db/schema.ts';
import { userByAccountId, userByLocalAccountId, userByUsername } from '../../db/scope.ts';
import { UNKNOWN_USERNAME_PLACEHOLDER } from '../../integrations/plex/accounts.ts';
import { networkKeyForIp } from './network.ts';

export type PlaybackObservationSource = 'webhook' | 'session_monitor';

export interface PlaybackObservationInput {
  serverId: number;
  plexAccountId: number | null;
  accountIdKind: 'local' | 'session';
  username: string | null;
  observedAt: number;
  event: string;
  ratingKey: string;
  ip: string | null;
  playerUuid: string | null;
  playerTitle: string | null;
  isLocal: boolean | null;
  source: PlaybackObservationSource;
  sessionKey?: string | null;
  scrobble?: { viewedAt: number | null; duration: number | null };
}

export type ObservationResult = 'inserted' | 'merged' | 'unmatched' | 'ambiguous';

const SAME_SOURCE_DEDUPE_SECONDS = 3;
// Polling can observe a disappearance up to one poll interval after Plex emits the
// corresponding webhook. Give cross-source matches one additional poll interval while
// retaining the tighter same-source window for genuinely consecutive plays.
const CROSS_SOURCE_DEDUPE_SECONDS = 30;

// Resolves PMS-local activity to the global plex.tv roster key, then performs every
// user/IP/observation write in one transaction. Both the automatic session monitor and
// optional webhook route use this path so account matching and privacy retention cannot
// drift between collectors.
export async function recordPlaybackObservation(
  input: PlaybackObservationInput,
): Promise<ObservationResult> {
  // Plex reserves account ID 0 for a nameless/system placeholder. It must never fall
  // through to username matching: doing so could attribute anonymous activity to a
  // real roster row that happens to share the supplied title.
  if (input.plexAccountId === 0) return 'unmatched';

  let candidates: Array<{ accountId: number }> = [];
  if (input.plexAccountId !== null && input.plexAccountId !== 0) {
    // /status/sessions has varied between global plex.tv and PMS-local user IDs across
    // server/client generations. Prefer the roster PK for session data, then try the
    // local mapping. Webhook Account.id is explicitly PMS-local.
    if (input.accountIdKind === 'session') {
      candidates = await db.select({ accountId: users.accountId })
        .from(users)
        .where(userByAccountId(input.serverId, input.plexAccountId));
    }
    if (candidates.length === 0) {
      candidates = await db.select({ accountId: users.accountId })
        .from(users)
        .where(userByLocalAccountId(input.serverId, input.plexAccountId));
    }
  }

  let backfillLocalId = false;
  if (
    candidates.length === 0 && input.username &&
    input.username !== UNKNOWN_USERNAME_PLACEHOLDER
  ) {
    candidates = await db.select({ accountId: users.accountId })
      .from(users)
      .where(userByUsername(input.serverId, input.username));
    backfillLocalId = input.accountIdKind === 'local' && input.plexAccountId !== null &&
      input.plexAccountId !== 0;
  }

  if (candidates.length === 0) return 'unmatched';
  if (candidates.length > 1) return 'ambiguous';

  const accountId = candidates[0].accountId;
  return withTransaction((client) => {
    const current = client.prepare(
      `SELECT last_ip, last_scrobbled_at FROM users
       WHERE server_id = ? AND account_id = ?`,
    ).get(input.serverId, accountId) as {
      last_ip: string | null;
      last_scrobbled_at: number | null;
    } | undefined;
    if (!current) return 'unmatched';

    const scrobbleAt = input.scrobble?.viewedAt ?? null;
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
      input.observedAt,
      input.playerTitle,
      backfillLocalId ? input.plexAccountId : null,
      countScrobble ? 1 : 0,
      countScrobble ? input.scrobble?.duration ?? 0 : 0,
      countScrobble ? scrobbleAt : null,
      input.serverId,
      accountId,
    );

    // A webhook and the session monitor normally observe the same transition within a
    // fraction of a second. Merge by session identity when available, otherwise by the
    // stable player UUID. Cross-source matches get enough time for one polling delay;
    // repeated events from the same source keep a tighter window so legitimate rapid
    // transitions or consecutive plays remain distinct.
    const existing = client.prepare(
      `SELECT id, source FROM user_play_observations
       WHERE server_id = ? AND account_id = ? AND event = ?
         AND observed_at BETWEEN ? AND ?
         AND (rating_key = ? OR rating_key IS NULL)
         AND (
           (source IN (?, 'both') AND observed_at BETWEEN ? AND ?)
           OR (source NOT IN (?, 'both') AND observed_at BETWEEN ? AND ?)
         )
         AND (
           (? IS NOT NULL AND session_key = ?)
           OR (? IS NOT NULL AND player_uuid = ?)
         )
       ORDER BY abs(observed_at - ?) ASC, id DESC LIMIT 1`,
    ).get(
      input.serverId,
      accountId,
      input.event,
      input.observedAt - CROSS_SOURCE_DEDUPE_SECONDS,
      input.observedAt + CROSS_SOURCE_DEDUPE_SECONDS,
      input.ratingKey,
      input.source,
      input.observedAt - SAME_SOURCE_DEDUPE_SECONDS,
      input.observedAt + SAME_SOURCE_DEDUPE_SECONDS,
      input.source,
      input.observedAt - CROSS_SOURCE_DEDUPE_SECONDS,
      input.observedAt + CROSS_SOURCE_DEDUPE_SECONDS,
      input.sessionKey ?? null,
      input.sessionKey ?? null,
      input.playerUuid,
      input.playerUuid,
      input.observedAt,
    ) as { id: number; source: string } | undefined;

    let result: ObservationResult;
    if (existing) {
      const source = existing.source === input.source || existing.source === 'both'
        ? existing.source
        : 'both';
      client.prepare(
        `UPDATE user_play_observations SET
           ip = coalesce(ip, ?),
           network_key = coalesce(network_key, ?),
           player_uuid = coalesce(player_uuid, ?),
           player_title = coalesce(player_title, ?),
           is_local = coalesce(is_local, ?),
           rating_key = coalesce(rating_key, ?),
           session_key = coalesce(session_key, ?),
           source = ?
         WHERE id = ?`,
      ).run(
        input.ip,
        networkKeyForIp(input.ip),
        input.playerUuid,
        input.playerTitle,
        input.isLocal === null ? null : Number(input.isLocal),
        input.ratingKey,
        input.sessionKey ?? null,
        source,
        existing.id,
      );
      result = 'merged';
    } else {
      client.prepare(
        `INSERT INTO user_play_observations
           (server_id, account_id, observed_at, event, ip, network_key, player_uuid,
            player_title, is_local, source, session_key, rating_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.serverId,
        accountId,
        input.observedAt,
        input.event,
        input.ip,
        networkKeyForIp(input.ip),
        input.playerUuid,
        input.playerTitle,
        input.isLocal === null ? null : Number(input.isLocal),
        input.source,
        input.sessionKey ?? null,
        input.ratingKey,
      );
      result = 'inserted';
    }

    if (input.ip !== null) {
      if (current.last_ip !== input.ip) {
        client.prepare(
          'UPDATE users SET last_ip = ? WHERE server_id = ? AND account_id = ?',
        ).run(input.ip, input.serverId, accountId);
        client.prepare(
          `INSERT INTO user_ip_history
             (server_id, account_id, ip, viewed_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(input.serverId, accountId, input.ip, input.observedAt, input.observedAt);
      } else {
        client.prepare(
          `UPDATE user_ip_history SET last_seen_at = ?
           WHERE id = (
             SELECT id FROM user_ip_history
             WHERE server_id = ? AND account_id = ? AND ip = ?
             ORDER BY viewed_at DESC, id DESC LIMIT 1
           )`,
        ).run(input.observedAt, input.serverId, accountId, input.ip);
      }
    }

    return result;
  });
}
