import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { syncLog } from '../db/schema.ts';
import { runSync } from '../services/sync.ts';

const router = new Hono();

router.post('/', async (c) => {
  const startedAt = Math.floor(Date.now() / 1000);

  const [existing] = await db
    .select({ id: syncLog.id })
    .from(syncLog)
    .where(eq(syncLog.status, 'pending'))
    .limit(1);
  if (existing) return c.json({ error: 'sync already in progress', syncId: existing.id }, 409);

  const [{ id: syncId }] = await db
    .insert(syncLog)
    .values({ startedAt, status: 'pending', itemsProcessed: 0 })
    .returning({ id: syncLog.id });

  // Fire and forget — caller polls GET /api/sync/:id for status
  void runSync(syncId);
  return c.json({ syncId, status: 'pending' }, 202);
});

router.get('/history', async (c) => {
  const rawLimit = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 20 : Math.min(rawLimit, 100);
  const rows = await db.select().from(syncLog).orderBy(desc(syncLog.startedAt)).limit(limit);
  return c.json(rows);
});

router.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (Number.isNaN(id)) return c.json({ error: 'invalid id' }, 400);
  const [row] = await db.select().from(syncLog).where(eq(syncLog.id, id)).limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
});

export default router;
