import { Hono } from 'hono';
import { timingSafeEqual } from '@std/crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { items } from '../db/schema.ts';
import type { PlexWebhookPayload } from '../lib/plex.ts';

// media.play  — fires immediately on playback start; stamps lastViewedAt = now for real-time feel
// media.scrobble — fires at 90% watched; carries Plex's authoritative viewCount increment
const HANDLED_EVENTS = new Set(['media.play', 'media.scrobble']);

const router = new Hono();

router.post('/plex', async (c) => {
  const secret = Deno.env.get('PLEX_WEBHOOK_SECRET');
  if (secret) {
    const encoder = new TextEncoder();
    // Hash both to a fixed-length digest so that tokens of different lengths
    // cannot be distinguished by response timing (prevents secret-length leak).
    const [provided, expected] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(c.req.query('token') ?? '')),
      crypto.subtle.digest('SHA-256', encoder.encode(secret)),
    ]);
    if (!timingSafeEqual(provided, expected)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
  }

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
    .where(eq(items.ratingKey, itemKey))
    .returning({ ratingKey: items.ratingKey });

  if (updated.length === 0) {
    console.warn(
      `webhook ${payload.event}: ${
        isEpisode ? 'show' : 'item'
      } ratingKey ${itemKey} not in DB — sync first`,
    );
  }

  return c.json({ ok: true });
});

export default router;
