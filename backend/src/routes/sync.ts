import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db, withTransaction } from '../db/index.ts';
import { libraries, syncLog } from '../db/schema.ts';
import { runSync, runLibrarySync } from '../services/sync.ts';
import type { SyncLog, SyncTriggerResponse } from '@plex-librarian/shared/types.ts';

const router = new Hono();

router.post('/', async (c) => {
  // Atomic check-then-insert: withTransaction is synchronous so no other
  // handler can slip a concurrent INSERT between the SELECT and INSERT.
  const startedAt = Math.floor(Date.now() / 1000);
  const result = withTransaction((client): { conflict: number } | { id: number } => {
    const existing = client
      .prepare("SELECT id FROM sync_log WHERE status = 'pending' LIMIT 1")
      .value<[number]>();
    if (existing) return { conflict: existing[0] };
    const row = client
      .prepare("INSERT INTO sync_log (started_at, status, items_processed) VALUES (?, 'pending', 0) RETURNING id")
      .value<[number]>(startedAt);
    if (!row) throw new Error('sync_log insert returned no id');
    return { id: row[0] };
  });

  if ('conflict' in result) {
    return c.json({ error: 'sync already in progress', syncId: result.conflict }, 409);
  }

  // Fire and forget — caller polls GET /api/sync/:id for status
  void runSync(result.id);
  return c.json({ syncId: result.id, status: 'pending' } satisfies SyncTriggerResponse, 202);
});

router.post('/libraries/:key', async (c) => {
  const key = c.req.param('key');

  const [library] = await db
    .select({ key: libraries.key })
    .from(libraries)
    .where(eq(libraries.key, key))
    .limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);

  // Block if a global sync is pending (covers all libraries) or this specific library
  // is already syncing. Other per-library syncs for different libraries can run concurrently
  // since all DB writes are scoped by libraryKey.
  // Atomic check-then-insert: withTransaction is synchronous so no concurrent
  // request can slip an INSERT between the SELECT and our INSERT.
  const startedAt = Math.floor(Date.now() / 1000);

  const result = withTransaction((client): { conflict: number } | { id: number } => {
    const existing = client
      .prepare("SELECT id FROM sync_log WHERE status = 'pending' AND (library_key IS NULL OR library_key = ?) LIMIT 1")
      .value<[number]>(key);
    if (existing) return { conflict: existing[0] };
    const row = client
      .prepare("INSERT INTO sync_log (library_key, started_at, status, items_processed) VALUES (?, ?, 'pending', 0) RETURNING id")
      .value<[number]>(key, startedAt);
    if (!row) throw new Error('sync_log insert returned no id');
    return { id: row[0] };
  });

  if ('conflict' in result) {
    return c.json({ error: 'sync already in progress', syncId: result.conflict }, 409);
  }

  void runLibrarySync(key, result.id);
  return c.json({ syncId: result.id, status: 'pending' } satisfies SyncTriggerResponse, 202);
});

router.get('/history', async (c) => {
  const rawLimit = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 20 : Math.min(rawLimit, 100);
  const rows = await db.select().from(syncLog).orderBy(desc(syncLog.startedAt)).limit(limit);
  return c.json(rows satisfies SyncLog[]);
});

router.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (Number.isNaN(id)) return c.json({ error: 'invalid id' }, 400);
  const [row] = await db.select().from(syncLog).where(eq(syncLog.id, id)).limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row satisfies SyncLog);
});

export default router;
