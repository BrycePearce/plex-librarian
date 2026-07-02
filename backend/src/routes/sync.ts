import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { libraries, syncLog } from '../db/schema.ts';
import { libraryByKey, syncLogById } from '../db/scope.ts';
import { type ActiveServerVariables, withActiveServerId } from '../middleware/activeServer.ts';
import { resolveActiveServer } from '../lib/plex.ts';
import {
  getSyncProgress,
  isSyncActive,
  registerStream,
  triggerFullSync,
  triggerLibrarySync,
  unregisterStream,
} from '../services/syncManager.ts';
import type { SyncLog, SyncTriggerResponse } from '@plex-librarian/shared/types.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

router.post('/', async (c) => {
  try {
    const active = await resolveActiveServer();
    const result = await triggerFullSync(active);
    if ('conflict' in result) {
      return c.json({ error: 'sync already in progress', syncId: result.conflict }, 409);
    }
    return c.json({ syncId: result.syncId, status: 'pending' } satisfies SyncTriggerResponse, 202);
  } catch (err) {
    console.error('Failed to trigger full sync:', err);
    return c.json({ error: 'failed to start sync' }, 503);
  }
});

router.post('/libraries/:key', async (c) => {
  const key = c.req.param('key');

  // Resolved once here (rather than reading the middleware's cached activeServerId and
  // letting triggerLibrarySync re-resolve independently) so a server switch racing with
  // this request can't validate the key against one server and sync a different one.
  let active: Awaited<ReturnType<typeof resolveActiveServer>>;
  try {
    active = await resolveActiveServer();
  } catch {
    return c.json({ error: 'library not found' }, 404);
  }

  const [library] = await db
    .select({ key: libraries.key })
    .from(libraries)
    .where(libraryByKey(active.serverId, key))
    .limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);

  try {
    const result = await triggerLibrarySync(active, key);
    if ('conflict' in result) {
      return c.json({ error: 'sync already in progress', syncId: result.conflict }, 409);
    }
    return c.json({ syncId: result.syncId, status: 'pending' } satisfies SyncTriggerResponse, 202);
  } catch (err) {
    console.error(`Failed to trigger library sync (key=${key}):`, err);
    return c.json({ error: 'failed to start sync' }, 503);
  }
});

router.get('/history', async (c) => {
  const rawLimit = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 20 : Math.min(rawLimit, 100);

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json([] satisfies SyncLog[]);

  // Tiebreak on id (strictly increasing with insertion order) in addition to startedAt
  // (only second-resolution) — otherwise two syncs triggered within the same wall-clock
  // second sort in whatever order SQLite happens to return ties in, which can put an
  // older sync above a newer pending one.
  const rows = await db.select().from(syncLog).where(eq(syncLog.serverId, serverId)).orderBy(
    desc(syncLog.startedAt),
    desc(syncLog.id),
  ).limit(limit);
  return c.json(rows satisfies SyncLog[]);
});

router.get('/:id/events', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (Number.isNaN(id)) return c.json({ error: 'invalid id' }, 400);

  // A sync's server_id is fixed at creation and never changes, so one ownership
  // check up front covers the rest of this request — including the in-memory
  // isSyncActive()/getSyncProgress() lookups below, which are keyed by syncId alone
  // and would otherwise happily stream another server's in-flight progress to
  // whichever server is currently active. 404 (not 403) so a stale/foreign id can't
  // be distinguished from one that never existed.
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'not found' }, 404);
  const [ownedRow] = await db.select({
    status: syncLog.status,
    itemsProcessed: syncLog.itemsProcessed,
    error: syncLog.error,
  }).from(syncLog)
    .where(syncLogById(serverId, id))
    .limit(1);
  if (!ownedRow) return c.json({ error: 'not found' }, 404);

  if (!isSyncActive(id)) {
    if (ownedRow.status === 'pending') {
      // Pending in DB but not yet registered — sync started but onLibraries hasn't fired
      return c.json({ error: 'sync not yet active' }, 503);
    }
    // The sync already finished by the time the client subscribed — common for small/fast
    // syncs, since triggering the sync and opening this stream are two separate round trips.
    // Stream the terminal event instead of erroring (mirrors the same race handled below,
    // after registerStream) so EventSource's normal complete/sync-error handling applies —
    // a non-2xx response here is fatal to EventSource (no auto-retry), which the frontend
    // was surfacing as a spurious "lost connection" for what is actually a successful sync.
    return streamSSE(c, async (stream) => {
      if (ownedRow.status === 'success') {
        await stream.writeSSE({
          event: 'complete',
          data: JSON.stringify({ itemsProcessed: ownedRow.itemsProcessed ?? 0 }),
        });
      } else {
        await stream.writeSSE({
          event: 'sync-error',
          data: JSON.stringify({ error: ownedRow.error ?? 'unknown' }),
        });
      }
    });
  }

  return streamSSE(c, async (stream) => {
    // Send current snapshot immediately so reconnecting clients catch up without waiting
    const snapshot = getSyncProgress(id);
    if (snapshot && snapshot.length > 0) {
      await stream.writeSSE({
        event: 'libraries',
        data: JSON.stringify({ libraries: snapshot.map((e) => ({ key: e.key, title: e.title })) }),
      });
      for (const lib of snapshot) {
        const phaseData: Record<string, unknown> = { libraryKey: lib.key, phase: lib.phase };
        if (lib.elapsedSeconds !== undefined) phaseData.elapsedSeconds = lib.elapsedSeconds;
        await stream.writeSSE({ event: 'phase', data: JSON.stringify(phaseData) });
        if (lib.count > 0) {
          await stream.writeSSE({
            event: 'count',
            data: JSON.stringify({ libraryKey: lib.key, delta: lib.count }),
          });
        }
      }
    }

    const done = registerStream(id, stream);

    // Guard: sync could have completed between the isSyncActive check and registerStream
    // (possible because snapshot sending above has awaits)
    if (!isSyncActive(id)) {
      unregisterStream(id, stream);
      const [row] = await db.select().from(syncLog).where(eq(syncLog.id, id)).limit(1);
      if (row?.status === 'success') {
        await stream.writeSSE({
          event: 'complete',
          data: JSON.stringify({ itemsProcessed: row.itemsProcessed ?? 0 }),
        });
      } else if (row?.status === 'error') {
        await stream.writeSSE({
          event: 'sync-error',
          data: JSON.stringify({ error: row.error ?? 'unknown' }),
        });
      }
      return;
    }

    c.req.raw.signal.addEventListener('abort', () => unregisterStream(id, stream));
    await done;
  });
});

router.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (Number.isNaN(id)) return c.json({ error: 'invalid id' }, 400);

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'not found' }, 404);
  const [row] = await db.select().from(syncLog)
    .where(syncLogById(serverId, id))
    .limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  const progress = getSyncProgress(id);
  if (progress) {
    const itemsProcessed = progress.reduce((sum, l) => sum + l.count, 0);
    return c.json({ ...row, itemsProcessed, progress } satisfies SyncLog);
  }
  // onLibraries hasn't fired yet — return an empty progress array so
  // the client always gets a consistent shape while status === 'pending'.
  if (row.status === 'pending') {
    return c.json({ ...row, progress: [] } satisfies SyncLog);
  }
  return c.json(row satisfies SyncLog);
});

export default router;
