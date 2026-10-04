import { Hono } from 'hono';
import { asc, count, eq } from 'drizzle-orm';
import { db, readDatabaseRevision } from '../../db/index.ts';
import { libraries } from '../../db/schema.ts';
import { libraryByKey } from '../../db/scope.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import type { LibrariesResponse } from '@plex-librarian/shared/types.ts';
import {
  automaticQuickCleanupThresholdDays,
  automaticStaleThresholdDays,
} from './automaticStaleThreshold.ts';
import detailRoute from './detailRoute.ts';
import quickCleanupRoute from './quickCleanupRoute.ts';
import staleRoute from './staleRoute.ts';
import { LibraryStatsCache } from './statsCache.ts';
import { type LibraryStatistics, readLibraryStatistics } from './statistics.ts';

const statsCache = new LibraryStatsCache<LibraryStatistics[]>(readDatabaseRevision);

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);
router.route('/', staleRoute);
router.route('/', quickCleanupRoute);
router.route('/', detailRoute);

router.get('/', async (c) => {
  const rawLimit = parseInt(c.req.query('limit') ?? '100', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 100 : Math.min(rawLimit, 1000);
  const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const serverId = c.get('activeServerId');
  if (serverId === null) {
    return c.json({ limit, offset, total: 0, libraries: [] } satisfies LibrariesResponse);
  }

  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(libraries).where(eq(libraries.serverId, serverId)),
    db.select().from(libraries).where(eq(libraries.serverId, serverId)).orderBy(
      asc(libraries.title),
    ).limit(limit).offset(offset),
  ]);

  // Aggregate only the returned libraries: a small page or past-end request must not
  // scan every item on the server. Keep aggregation in SQLite and preserve the text
  // cast, which avoids the driver's 32-bit integer read path for large size totals.
  const statsRows = rows.length === 0 ? [] : await statsCache.get(
    serverId,
    rows.map((library) => library.key),
    () => readLibraryStatistics(serverId, rows.map((library) => library.key)),
  );

  const statsByKey = new Map(statsRows.map((r) => [r.libraryKey, r]));
  const now = Math.floor(Date.now() / 1000);
  const librariesWithStats = rows.map((lib) => {
    const stats = statsByKey.get(lib.key);
    return {
      ...lib,
      automaticStaleDays: automaticStaleThresholdDays(lib.oldestItemAddedAt, now),
      automaticQuickCleanupDays: automaticQuickCleanupThresholdDays(
        lib.oldestItemAddedAt,
        now,
      ),
      itemCount: stats?.itemCount ?? 0,
      totalFileSize: stats ? Number(stats.totalFileSize ?? '0') : 0,
    };
  });

  return c.json(
    { limit, offset, total, libraries: librariesWithStats } satisfies LibrariesResponse,
  );
});

router.patch('/:key', async (c) => {
  const key = c.req.param('key');
  const body = await c.req.json() as { staleMinAgeDays?: unknown };

  if (
    body.staleMinAgeDays !== null &&
    (typeof body.staleMinAgeDays !== 'number' || !Number.isInteger(body.staleMinAgeDays) ||
      body.staleMinAgeDays < 0)
  ) {
    return c.json({ error: 'staleMinAgeDays must be null or a non-negative integer' }, 400);
  }

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'library not found' }, 404);

  const [library] = await db.select().from(libraries)
    .where(libraryByKey(serverId, key))
    .limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);

  await db.update(libraries)
    .set({ staleMinAgeDays: body.staleMinAgeDays })
    .where(libraryByKey(serverId, key));

  return c.json({ ...library, staleMinAgeDays: body.staleMinAgeDays });
});

export default router;
