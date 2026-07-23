import { Hono } from 'hono';
import { db } from '../../db/index.ts';
import { items } from '../../db/schema.ts';
import { itemByRatingKey } from '../../db/scope.ts';
import { getActiveServer } from '../../integrations/plex/index.ts';
import type { PlexWebhookPayload } from '../../integrations/plex/index.ts';
import { recordPlaybackObservation } from '../users/observationService.ts';

const PLAYBACK_EVENTS = new Set([
  'media.play',
  'media.pause',
  'media.resume',
  'media.stop',
  'media.scrobble',
]);
const ITEM_ACTIVITY_EVENTS = new Set(['media.play', 'media.resume', 'media.scrobble']);

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
  if (!PLAYBACK_EVENTS.has(payload.event) || !Metadata?.ratingKey) {
    return c.json({ ok: true });
  }

  // A webhook can follow an account to servers other than the one currently selected
  // in Plex Librarian. Only ingest events from the active server.
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

  if (ITEM_ACTIVITY_EVENTS.has(payload.event)) {
    const itemKey = isEpisode ? Metadata.grandparentRatingKey : Metadata.ratingKey;
    if (!itemKey) {
      console.warn(
        `webhook ${payload.event}: episode missing grandparentRatingKey — skipping item update`,
      );
    } else {
      const updated = await db.update(items).set({
        lastViewedAt: now,
        updatedAt: now,
        ...(!isEpisode && isScrobble && Metadata.viewCount != null
          ? { viewCount: Metadata.viewCount }
          : {}),
      }).where(itemByRatingKey(serverId, itemKey)).returning({ ratingKey: items.ratingKey });
      if (updated.length === 0) {
        console.warn(
          `webhook ${payload.event}: ${
            isEpisode ? 'show' : 'item'
          } ratingKey ${itemKey} not in DB — sync first`,
        );
      }
    }
  }

  const result = await recordPlaybackObservation({
    serverId,
    plexAccountId: payload.Account?.id ?? null,
    accountIdKind: 'local',
    observedAt: now,
    event: payload.event,
    ratingKey: Metadata.ratingKey,
    ip: payload.Player?.publicAddress || null,
    playerUuid: payload.Player?.uuid ?? null,
    playerTitle: payload.Player?.title ?? null,
    isLocal: payload.Player?.local ?? null,
    source: 'webhook',
    scrobble: isScrobble
      ? { viewedAt: Metadata.lastViewedAt ?? null, duration: Metadata.duration ?? null }
      : undefined,
  });
  if (result === 'ambiguous') {
    console.warn(
      `webhook ${payload.event}: account=${payload.Account?.id} title="${payload.Account?.title}" matched multiple users — skipping activity update`,
    );
  }

  return c.json({ ok: true });
});

export default router;
