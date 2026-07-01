import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { libraries, syncLog } from '../db/schema.ts';
import {
  getSyncProgress,
  isSyncActive,
  registerStream,
  triggerFullSync,
  triggerLibrarySync,
  unregisterStream,
} from '../services/syncManager.ts';
import type { SyncLog, SyncTriggerResponse } from '@plex-librarian/shared/types.ts';

const router = new Hono();

router.post('/', (c) => {
  try {
    const result = triggerFullSync();
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

  const [library] = await db
    .select({ key: libraries.key })
    .from(libraries)
    .where(eq(libraries.key, key))
    .limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);

  try {
    const result = triggerLibrarySync(key);
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
  const rows = await db.select().from(syncLog).orderBy(desc(syncLog.startedAt)).limit(limit);
  return c.json(rows satisfies SyncLog[]);
});

router.get('/:id/events', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (Number.isNaN(id)) return c.json({ error: 'invalid id' }, 400);

  if (!isSyncActive(id)) {
    const [row] = await db.select().from(syncLog).where(eq(syncLog.id, id)).limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.status !== 'pending') return c.json({ error: 'sync complete' }, 410);
    // Pending in DB but not yet registered — sync started but onLibraries hasn't fired
    return c.json({ error: 'sync not yet active' }, 503);
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
  const [row] = await db.select().from(syncLog).where(eq(syncLog.id, id)).limit(1);
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
