import { Hono } from 'hono';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  episodeMediaVersions,
  itemMediaVersions,
  items,
  libraries,
  seasons,
  settings,
} from '../../db/schema.ts';
import {
  episodeVersionsByLibrary,
  HAS_DUPLICATE_VERSIONS,
  itemByRatingKey,
  itemsByLibrary,
  libraryByKey,
  mediaVersionsByLibrary,
  seasonsByShow,
} from '../../db/scope.ts';
import { createPlexClient, PlexDeleteError } from '../../integrations/plex/index.ts';
import { logEvents } from '../events/service.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import type {
  DeleteItemsResponse,
  LibrariesResponse,
  MediaVersion,
  MovieDetail,
  ShowDetail,
  StaleResponse,
} from '@plex-librarian/shared/types.ts';
import { staleCutoffs } from './staleFilters.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

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

  const serverId = c.get('activeServerId');
  if (serverId === null) {
    return c.json({ limit, offset, total: 0, libraries: [] } satisfies LibrariesResponse);
  }

  const [[{ total }], rows, statsRows] = await Promise.all([
    db.select({ total: count() }).from(libraries).where(eq(libraries.serverId, serverId)),
    db.select().from(libraries).where(eq(libraries.serverId, serverId)).orderBy(
      asc(libraries.title),
    ).limit(limit).offset(offset),
    // Single grouped aggregate rather than one query per library — cheap even at millions
    // of rows since it's backed by the existing (serverId, libraryKey) index, and avoids
    // ever pulling item rows into app memory (see Scale assumptions in CLAUDE.md).
    // SUM(file_size) is cast to text in SQL: @db/sqlite's integer read path truncates
    // SUM's result to 32 bits, silently wrapping (and going negative) for any library
    // whose total size exceeds ~2^31 KB (~2TB) — verified against a manual JS-side sum.
    // The text cast returns SQLite's full-precision result as a string instead.
    db.select({
      libraryKey: items.libraryKey,
      itemCount: count(),
      totalFileSize: sql<string | null>`cast(sum(${items.fileSize}) as text)`,
    }).from(items).where(eq(items.serverId, serverId)).groupBy(items.libraryKey),
  ]);

  const statsByKey = new Map(statsRows.map((r) => [r.libraryKey, r]));
  const librariesWithStats = rows.map((lib) => {
    const stats = statsByKey.get(lib.key);
    return {
      ...lib,
      itemCount: stats?.itemCount ?? 0,
      totalFileSize: stats ? Number(stats.totalFileSize ?? '0') : 0,
    };
  });

  return c.json(
    { limit, offset, total, libraries: librariesWithStats } satisfies LibrariesResponse,
  );
});

router.get('/:key/stale', async (c) => {
  const key = c.req.param('key');

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'library not found' }, 404);

  const [library] = await db.select({
    key: libraries.key,
    type: libraries.type,
    staleMinAgeDays: libraries.staleMinAgeDays,
    historySyncedAt: libraries.historySyncedAt,
  })
    .from(libraries)
    .where(libraryByKey(serverId, key))
    .limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);

  // Minimum inactivity: time since last view for watched items, or time since added for
  // never-watched items (default 365).
  const rawDays = Number(c.req.query('days') ?? '365');
  if (!Number.isInteger(rawDays) || rawDays < 1) {
    return c.json({
      error: 'days must be a positive integer',
    }, 400);
  }
  const days = rawDays;

  // Maximum staleness: upper bound for range-bucket queries (e.g. days=365&maxDays=730 → 1-2 yr).
  // Must be greater than days; otherwise the time window is inverted and matches nothing.
  const rawMaxDays = c.req.query('maxDays');
  const parsedMaxDays = rawMaxDays !== undefined ? Number(rawMaxDays) : null;
  if (parsedMaxDays !== null && (!Number.isInteger(parsedMaxDays) || parsedMaxDays < 1)) {
    return c.json({ error: 'maxDays must be a positive integer' }, 400);
  }
  const maxDays = parsedMaxDays;
  if (maxDays !== null && maxDays <= days) {
    return c.json({ error: 'maxDays must be greater than days' }, 400);
  }

  // Additional minimum-age safety floor for never-watched items.
  // Resolution order: explicit query param > library override > global default > 90.
  const rawMinAgeDays = c.req.query('minAgeDays');
  let minAgeDays: number;
  if (rawMinAgeDays !== undefined) {
    const parsed = Number(rawMinAgeDays);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return c.json({ error: 'minAgeDays must be a non-negative integer' }, 400);
    }
    minAgeDays = parsed;
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
  const {
    viewedBefore,
    viewedOnOrAfter,
    unwatchedAddedBefore,
    unwatchedAddedOnOrAfter,
  } = staleCutoffs(
    now,
    days,
    maxDays,
    minAgeDays,
  );

  // Watched but stale: viewed before the minimum boundary and, for range queries,
  // on or after the maximum boundary.
  const watchedStaleCond = and(
    isNotNull(items.lastViewedAt),
    viewedOnOrAfter !== null
      ? and(lt(items.lastViewedAt, viewedBefore), gte(items.lastViewedAt, viewedOnOrAfter))
      : lt(items.lastViewedAt, viewedBefore),
  );

  // Unwatched: null lastViewedAt AND old enough for both the selected inactivity
  // duration and the minimum-item-age safety floor (the stricter boundary wins).
  // Unknown add dates are excluded: they cannot prove that the item has met the selected
  // threshold, which matters when this list informs destructive cleanup decisions.
  const unwatchedCond = and(
    isNull(items.lastViewedAt),
    isNotNull(items.addedAt),
    unwatchedAddedOnOrAfter !== null
      ? and(lt(items.addedAt, unwatchedAddedBefore), gte(items.addedAt, unwatchedAddedOnOrAfter))
      : lt(items.addedAt, unwatchedAddedBefore),
  );

  const staleCond = filter === 'unwatched'
    ? unwatchedCond
    : filter === 'watched'
    ? watchedStaleCond
    : or(unwatchedCond, watchedStaleCond);

  // Semantics deliberately differ by library type — see Duplicate detection in
  // CLAUDE.md. Movie: this item itself has 2+ synced versions (same grouping as the
  // global duplicates endpoint). Show: at least one of this show's episodes has 2+
  // synced versions (existence only — episode_media_versions only ever holds genuine
  // duplicates, see its write-time filtering). Artist/other: no-op, ignored.
  const requestedDuplicatesOnly = c.req.query('duplicatesOnly') === 'true';
  let duplicatesCond: SQL | undefined;
  if (requestedDuplicatesOnly && library.type === 'movie') {
    duplicatesCond = sql`${items.ratingKey} in (
      select ${itemMediaVersions.itemRatingKey} from ${itemMediaVersions}
      where ${itemMediaVersions.serverId} = ${serverId} and ${itemMediaVersions.libraryKey} = ${key}
      group by ${itemMediaVersions.itemRatingKey} having ${HAS_DUPLICATE_VERSIONS}
    )`;
  } else if (requestedDuplicatesOnly && library.type === 'show') {
    duplicatesCond = sql`exists (
      select 1 from ${episodeMediaVersions}
      where ${episodeMediaVersions.serverId} = ${serverId}
        and ${episodeMediaVersions.libraryKey} = ${key}
        and ${episodeMediaVersions.showRatingKey} = ${items.ratingKey}
    )`;
  }
  // Reflects whether filtering was actually applied, not just what was requested —
  // library types other than movie/show (e.g. artist) have no duplicate-detection
  // support, so a request for them is silently a no-op and must not claim otherwise.
  const duplicatesOnly = duplicatesCond !== undefined;

  const staleWhere = duplicatesCond
    ? and(itemsByLibrary(serverId, key), staleCond, duplicatesCond)
    : and(itemsByLibrary(serverId, key), staleCond);

  const [[{ total }], staleItems] = await Promise.all([
    db.select({ total: count() }).from(items).where(staleWhere),
    db.select().from(items).where(staleWhere).orderBy(order(SORT_COLUMNS[sort])).limit(limit)
      .offset(offset),
  ]);

  // Attaches the full per-version breakdown to items whose fileSize is a combined
  // total across multiple synced Plex Media versions (see Duplicate detection in
  // CLAUDE.md) — deleting such an item from this page's bulk-delete flow removes every
  // version, not just a redundant one, so the frontend renders the breakdown rather
  // than letting that be a silent surprise. Scoped to just this page's rows (≤ limit,
  // capped at 1000), backed by the existing (serverId, itemRatingKey) index — cheap
  // regardless of library size, and duplicate-having movies are a small subset besides.
  const pageRatingKeys = staleItems.map((i) => i.ratingKey);
  const pageVersionRows = pageRatingKeys.length === 0 ? [] : await db
    .select()
    .from(itemMediaVersions)
    .where(
      and(
        mediaVersionsByLibrary(serverId, key),
        inArray(itemMediaVersions.itemRatingKey, pageRatingKeys),
      ),
    );
  const versionsByKey = new Map<string, MediaVersion[]>();
  for (const v of pageVersionRows) {
    const list = versionsByKey.get(v.itemRatingKey) ?? [];
    list.push({
      mediaId: v.mediaId,
      videoResolution: v.videoResolution,
      bitrate: v.bitrate,
      videoCodec: v.videoCodec,
      container: v.container,
      fileSize: v.fileSize,
    });
    versionsByKey.set(v.itemRatingKey, list);
  }

  // Existence-only badge for shows with a duplicate episode somewhere underneath —
  // runs unconditionally the same way pageVersionRows does above (naturally empty for
  // non-show libraries, one less branch to maintain), not gated behind duplicatesOnly.
  const pageEpisodeVersionRows = pageRatingKeys.length === 0 ? [] : await db
    .selectDistinct({ showRatingKey: episodeMediaVersions.showRatingKey })
    .from(episodeMediaVersions)
    .where(
      and(
        episodeVersionsByLibrary(serverId, key),
        inArray(episodeMediaVersions.showRatingKey, pageRatingKeys),
      ),
    );
  const showsWithDuplicateEpisodes = new Set(pageEpisodeVersionRows.map((r) => r.showRatingKey));

  return c.json(
    {
      days,
      maxDays,
      minAgeDays,
      libraryStaleMinAgeDays: library.staleMinAgeDays,
      historySyncedAt: library.historySyncedAt,
      filter,
      sort,
      order: orderStr,
      duplicatesOnly,
      limit,
      offset,
      total,
      items: staleItems.map((item) => {
        const versions = versionsByKey.get(item.ratingKey);
        return {
          ...item,
          ...(versions && versions.length >= 2 ? { versions } : {}),
          ...(showsWithDuplicateEpisodes.has(item.ratingKey)
            ? { hasDuplicateEpisodes: true as const }
            : {}),
        };
      }),
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

// Deletes items' media from Plex (metadata + underlying file(s) on disk — permanent,
// not a soft delete) and prunes the corresponding local rows. For TV libraries, items
// are synced at show granularity (see CLAUDE.md), so deleting a show's ratingKey
// cascades to all of its episodes on Plex's side; the local `seasons` rows follow via
// the items -> seasons ON DELETE CASCADE FK.
router.delete('/:key/items', async (c) => {
  const key = c.req.param('key');
  const body = await c.req.json().catch(() => null) as { ratingKeys?: unknown } | null;

  if (!body || !Array.isArray(body.ratingKeys) || body.ratingKeys.length === 0) {
    return c.json({ error: 'ratingKeys must be a non-empty array' }, 400);
  }
  if (body.ratingKeys.length > 200) {
    return c.json({ error: 'cannot delete more than 200 items at once' }, 400);
  }
  if (!body.ratingKeys.every((k): k is string => typeof k === 'string')) {
    return c.json({ error: 'ratingKeys must be strings' }, 400);
  }
  // Deduped so a client sending the same ratingKey twice can't double-count it in the
  // response or the persisted items.deleted event's deletedCount/fileSizeFreed.
  const ratingKeys = [...new Set(body.ratingKeys as string[])];

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'library not found' }, 404);

  const [library] = await db.select({ key: libraries.key }).from(libraries)
    .where(libraryByKey(serverId, key)).limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);

  // Only ever act on items that actually belong to this library/server — guards
  // against a client passing ratingKeys scraped from a different library or server.
  // fileSize (decimal KB — see extractFileSize in integrations/plex) is captured here
  // (before the rows are deleted below) so the activity event can report space
  // freed without a second query.
  const owned = await db.select({ ratingKey: items.ratingKey, fileSize: items.fileSize })
    .from(items)
    .where(and(itemsByLibrary(serverId, key), inArray(items.ratingKey, ratingKeys)));
  const fileSizeByKey = new Map(owned.map((r) => [r.ratingKey, r.fileSize ?? 0]));

  let client;
  try {
    client = await createPlexClient();
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Plex is not configured' }, 502);
  }

  // Sequential, not concurrent: deletion is destructive and irreversible, and the
  // per-item result needs to be attributable — worth the extra latency for a
  // user-triggered, page-sized (<=200) action.
  const deleted: string[] = [];
  const failed: { ratingKey: string; error: string }[] = [];
  for (const ratingKey of ratingKeys) {
    if (!fileSizeByKey.has(ratingKey)) {
      failed.push({ ratingKey, error: 'not found in this library' });
      continue;
    }
    try {
      await client.deleteItem(ratingKey);
      await db.delete(items).where(itemByRatingKey(serverId, ratingKey));
      deleted.push(ratingKey);
    } catch (err) {
      // A 404 means Plex already has no record of this item — most likely it was
      // deleted directly in Plex outside this app. Treat that as success and drop the
      // now-orphaned local row, rather than leaving it permanently stuck failing every
      // future delete attempt.
      if (err instanceof PlexDeleteError && err.status === 404) {
        await db.delete(items).where(itemByRatingKey(serverId, ratingKey));
        deleted.push(ratingKey);
        continue;
      }
      failed.push({ ratingKey, error: err instanceof Error ? err.message : 'delete failed' });
    }
  }

  // Decimal KB, matching Library.totalFileSize / StaleItem.fileSize — see formatKilobytes
  // in frontend/src/lib/format.ts.
  const fileSizeFreed = deleted.reduce((sum, rk) => sum + (fileSizeByKey.get(rk) ?? 0), 0);
  await logEvents([{
    serverId,
    type: 'items.deleted',
    payload: {
      libraryKey: key,
      deletedCount: deleted.length,
      failedCount: failed.length,
      fileSizeFreed,
    },
  }]);

  return c.json({ deleted, failed } satisfies DeleteItemsResponse);
});

router.get('/:key/shows/:ratingKey', async (c) => {
  const key = c.req.param('key');
  const ratingKey = c.req.param('ratingKey');

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'show not found' }, 404);

  const [show] = await db
    .select()
    .from(items)
    .where(and(itemByRatingKey(serverId, ratingKey), eq(items.libraryKey, key)))
    .limit(1);
  if (!show) return c.json({ error: 'show not found' }, 404);

  const [showSeasons, [library]] = await Promise.all([
    db
      .select()
      .from(seasons)
      .where(and(seasonsByShow(serverId, ratingKey), eq(seasons.libraryKey, key)))
      .orderBy(asc(seasons.seasonIndex)),
    db.select({ historySyncedAt: libraries.historySyncedAt })
      .from(libraries)
      .where(libraryByKey(serverId, key))
      .limit(1),
  ]);

  return c.json(
    {
      show,
      seasons: showSeasons,
      historySyncedAt: library?.historySyncedAt ?? null,
    } satisfies ShowDetail,
  );
});

router.get('/:key/movies/:ratingKey', async (c) => {
  const key = c.req.param('key');
  const ratingKey = c.req.param('ratingKey');

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'movie not found' }, 404);

  const [[movie], [library]] = await Promise.all([
    db
      .select()
      .from(items)
      .where(and(itemByRatingKey(serverId, ratingKey), eq(items.libraryKey, key)))
      .limit(1),
    db.select({ historySyncedAt: libraries.historySyncedAt })
      .from(libraries)
      .where(libraryByKey(serverId, key))
      .limit(1),
  ]);
  if (!movie) return c.json({ error: 'movie not found' }, 404);

  return c.json(
    {
      movie,
      historySyncedAt: library?.historySyncedAt ?? null,
    } satisfies MovieDetail,
  );
});

export default router;
