import { Hono } from 'hono';
import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { events } from '../db/schema.ts';
import { type ActiveServerVariables, withActiveServerId } from '../middleware/activeServer.ts';
import type { ActivityEvent, ActivityEventsResponse } from '@plex-librarian/shared/types.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

router.get('/', async (c) => {
  const rawLimit = parseInt(c.req.query('limit') ?? '30', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 30 : Math.min(rawLimit, 100);

  const rawBefore = c.req.query('before');
  const before = rawBefore !== undefined ? parseInt(rawBefore, 10) : undefined;
  if (before !== undefined && Number.isNaN(before)) {
    return c.json({ error: 'invalid before cursor' }, 400);
  }

  const serverId = c.get('activeServerId');
  if (serverId === null) {
    return c.json({ limit, events: [], nextCursor: null } satisfies ActivityEventsResponse);
  }

  // Fetch one extra row to know whether there's more history beyond this page —
  // avoids a separate COUNT query just to decide whether to hand back a nextCursor.
  const rows = await db.select().from(events)
    .where(
      before !== undefined
        ? and(eq(events.serverId, serverId), lt(events.id, before))
        : eq(events.serverId, serverId),
    )
    .orderBy(desc(events.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1].id : null;

  // Trust boundary: `payload` is an untyped JSON blob in SQLite — we assert the shape
  // here rather than validate it, same as logEvents()'s discriminated LogEventInput
  // guarantees it was written correctly in the first place. `type` itself is narrowed
  // by the schema's `{ enum: [...] }` column definition (matches EventType exactly).
  const result: ActivityEvent[] = page.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload ? JSON.parse(row.payload) : null,
    createdAt: row.createdAt,
  } as ActivityEvent));

  return c.json({ limit, events: result, nextCursor } satisfies ActivityEventsResponse);
});

export default router;
