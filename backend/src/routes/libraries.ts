import { Hono } from 'hono';
import { and, asc, count, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { items, libraries } from '../db/schema.ts';

const router = new Hono();

router.get('/', async (c) => {
  const rawLimit = parseInt(c.req.query('limit') ?? '100', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 100 : Math.min(rawLimit, 1000);
  const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(libraries),
    db.select().from(libraries).orderBy(asc(libraries.title)).limit(limit).offset(offset),
  ]);

  return c.json({ limit, offset, total, libraries: rows });
});

router.get('/:key/stale', async (c) => {
  const key = c.req.param('key');

  const [library] = await db.select({ key: libraries.key }).from(libraries).where(
    eq(libraries.key, key),
  ).limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);

  const rawDays = parseInt(c.req.query('days') ?? '365', 10);
  const days = Number.isNaN(rawDays) || rawDays < 0 ? 365 : rawDays;
  const cutoff = days === 0 ? null : Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;

  const rawLimit = parseInt(c.req.query('limit') ?? '500', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 500 : Math.min(rawLimit, 1000);
  const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const staleWhere = and(
    eq(items.libraryKey, key),
    cutoff === null ? isNull(items.lastViewedAt) : or(isNull(items.lastViewedAt), lt(items.lastViewedAt, cutoff)),
  );

  const [[{ total }], staleItems] = await Promise.all([
    db.select({ total: count() }).from(items).where(staleWhere),
    db.select().from(items).where(staleWhere).orderBy(desc(items.fileSize)).limit(limit).offset(
      offset,
    ),
  ]);

  return c.json({ days, limit, offset, total, items: staleItems });
});

export default router;
