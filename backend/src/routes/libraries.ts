import { Hono } from 'hono';
import { and, asc, count, desc, eq, gte, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { items, libraries, seasons, settings } from '../db/schema.ts';
import type { LibrariesResponse, ShowDetail, StaleResponse } from '@plex-librarian/shared/types.ts';

const router = new Hono();

const SORT_COLUMNS = {
  fileSize: items.fileSize,
  lastViewedAt: items.lastViewedAt,
  addedAt: items.addedAt,
  title: items.title,
  year: items.year,
  viewCount: items.viewCount,
} as const;

type SortKey = keyof typeof SORT_COLUMNS;

router.get('/', async (c) => {
  const rawLimit = parseInt(c.req.query('limit') ?? '100', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 100 : Math.min(rawLimit, 1000);
  const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(libraries),
    db.select().from(libraries).orderBy(asc(libraries.title)).limit(limit).offset(offset),
  ]);

  return c.json({ limit, offset, total, libraries: rows } satisfies LibrariesResponse);
});

router.get('/:key/stale', async (c) => {
  const key = c.req.param('key');

  const [library] = await db.select({
    key: libraries.key,
    staleMinAgeDays: libraries.staleMinAgeDays,
  })
    .from(libraries)
    .where(eq(libraries.key, key))
    .limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);

  // Minimum staleness: items not viewed in at least this many days (default 365).
  // Use filter=unwatched for never-watched items regardless of age.
  const rawDays = parseInt(c.req.query('days') ?? '365', 10);
  if (!Number.isNaN(rawDays) && rawDays < 1) {
    return c.json({
      error: 'days must be at least 1; use filter=unwatched for never-watched items',
    }, 400);
  }
  const days = Number.isNaN(rawDays) ? 365 : rawDays;

  // Maximum staleness: upper bound for range-bucket queries (e.g. days=365&maxDays=730 → 1-2 yr).
  // Must be greater than days; otherwise the time window is inverted and matches nothing.
  const rawMaxDays = c.req.query('maxDays');
  const parsedMaxDays = rawMaxDays !== undefined ? parseInt(rawMaxDays, 10) : null;
  if (parsedMaxDays !== null && (Number.isNaN(parsedMaxDays) || parsedMaxDays < 1)) {
    return c.json({ error: 'maxDays must be at least 1' }, 400);
  }
  const maxDays = parsedMaxDays;
  if (maxDays !== null && maxDays <= days) {
    return c.json({ error: 'maxDays must be greater than days' }, 400);
  }

  // Items added within this window are excluded from unwatched results.
  // Resolution order: explicit query param > library override > global default > 90.
  const rawMinAgeDays = c.req.query('minAgeDays');
  let minAgeDays: number;
  if (rawMinAgeDays !== undefined) {
    const parsed = parseInt(rawMinAgeDays, 10);
    minAgeDays = Number.isNaN(parsed) || parsed < 0 ? 90 : parsed;
  } else if (library.staleMinAgeDays !== null) {
    minAgeDays = library.staleMinAgeDays;
  } else {
    const [settingsRow] = await db.select({ staleMinAgeDays: settings.staleMinAgeDays })
      .from(settings)
      .where(eq(settings.id, 1))
      .limit(1);
    minAgeDays = settingsRow?.staleMinAgeDays ?? 90;
  }

  // filter=all (default): watched-stale + unwatched
  // filter=watched: only items with a lastViewedAt in the stale range
  // filter=unwatched: only items never watched (respects minAgeDays)
  const rawFilter = c.req.query('filter') ?? 'all';
  const filter = ['all', 'watched', 'unwatched'].includes(rawFilter) ? rawFilter : 'all';

  // sort=fileSize (default) | lastViewedAt | addedAt | title | year | viewCount
  // order=desc (default) | asc
  const rawSort = c.req.query('sort') ?? 'fileSize';
  const sort: SortKey = rawSort in SORT_COLUMNS ? rawSort as SortKey : 'fileSize';
  const orderStr = c.req.query('order') === 'asc' ? 'asc' : 'desc';
  const order = orderStr === 'asc' ? asc : desc;

  const rawLimit = parseInt(c.req.query('limit') ?? '500', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 500 : Math.min(rawLimit, 1000);
  const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const now = Math.floor(Date.now() / 1000);
  const minCutoff = now - days * 86400;
  const maxCutoff = maxDays !== null ? now - maxDays * 86400 : null;
  const ageCutoff = now - minAgeDays * 86400;

  // Watched but stale: viewed before minCutoff, and (if maxDays set) after maxCutoff.
  const watchedStaleCond = and(
    isNotNull(items.lastViewedAt),
    maxCutoff !== null
      ? and(lt(items.lastViewedAt, minCutoff), gte(items.lastViewedAt, maxCutoff))
      : lt(items.lastViewedAt, minCutoff),
  );

  // Unwatched: null lastViewedAt AND added before the minAgeDays cutoff.
  // Items with null addedAt are included — unknown add date doesn't mean recently added.
  const unwatchedCond = and(
    isNull(items.lastViewedAt),
    or(isNull(items.addedAt), lt(items.addedAt, ageCutoff)),
  );

  const staleCond = filter === 'unwatched'
    ? unwatchedCond
    : filter === 'watched'
    ? watchedStaleCond
    : or(unwatchedCond, watchedStaleCond);

  const staleWhere = and(eq(items.libraryKey, key), staleCond);

  const [[{ total }], staleItems] = await Promise.all([
    db.select({ total: count() }).from(items).where(staleWhere),
    db.select().from(items).where(staleWhere).orderBy(order(SORT_COLUMNS[sort])).limit(limit)
      .offset(offset),
  ]);

  return c.json(
    {
      days,
      maxDays,
      minAgeDays,
      libraryStaleMinAgeDays: library.staleMinAgeDays,
      filter,
      sort,
      order: orderStr,
      limit,
      offset,
      total,
      items: staleItems,
    } satisfies StaleResponse,
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

  const [library] = await db.select().from(libraries).where(eq(libraries.key, key)).limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);

  await db.update(libraries)
    .set({ staleMinAgeDays: body.staleMinAgeDays })
    .where(eq(libraries.key, key));

  return c.json({ ...library, staleMinAgeDays: body.staleMinAgeDays });
});

router.get('/:key/shows/:ratingKey', async (c) => {
  const key = c.req.param('key');
  const ratingKey = c.req.param('ratingKey');

  const [show] = await db
    .select()
    .from(items)
    .where(and(eq(items.ratingKey, ratingKey), eq(items.libraryKey, key)))
    .limit(1);
  if (!show) return c.json({ error: 'show not found' }, 404);

  const showSeasons = await db
    .select()
    .from(seasons)
    .where(and(eq(seasons.showRatingKey, ratingKey), eq(seasons.libraryKey, key)))
    .orderBy(asc(seasons.seasonIndex));

  return c.json({ show, seasons: showSeasons } satisfies ShowDetail);
});

export default router;
