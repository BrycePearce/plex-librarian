import { Hono } from 'hono';
import { and, desc, eq, inArray, not, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { episodeMediaVersions, itemMediaVersions, items } from '../../db/schema.ts';
import { HAS_DUPLICATE_VERSIONS } from '../../db/scope.ts';
import { parseSearchQuery } from '../../http/searchQuery.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import type {
  DuplicateEpisodeGroup,
  DuplicateListGroup,
  DuplicateMovieGroup,
  DuplicateSeasonGroup,
  DuplicatesResponse,
} from '@plex-librarian/shared/types.ts';
import {
  compareDuplicateVersions,
  type DuplicateComparisonFilter,
  summarizeDuplicateComparisons,
} from '@plex-librarian/shared/mediaComparison.ts';
import { mediaVersionFromRow } from './mediaVersion.ts';
import {
  episodeRootIsWorkflowOwned,
  movieRootIsWorkflowOwned,
} from '../deletionOperations/core/ownership.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

// True duplicate *groups* (as opposed to raw item/episode counts, which can be huge —
// see CLAUDE.md's Scale assumptions) are expected to stay small server-wide, even
// though the underlying item_media_versions/episode_media_versions tables could
// theoretically be large. This cap is a defensive safety valve, not a real limit: if a
// server ever has more than 2000 genuine duplicate groups of one media type, groups
// ranked beyond the cap simply won't surface, even via deep pagination. Documented here
// so that's a known, remote tradeoff rather than a support-ticket surprise.
const GROUP_FETCH_CAP = 2000;
const VERSION_FILTER_BATCH_SIZE = 400;
// Technical comparison filters must inspect every duplicate episode in each candidate
// season, but retaining all of those version rows at once can scale with the whole TV
// library. Process only a small number of seasons at a time and retain lightweight
// summaries until the final page is known.
const SEASON_FILTER_BATCH_SIZE = 25;
const SEASON_EPISODE_READ_PAGE_SIZE = 500;
// The list endpoint carries full media/stream detail for every returned episode.
// Keep only a compact preview per season; opening the season performs the separately
// bounded authoritative analysis.
const SEASON_LIST_EPISODE_SAMPLE_LIMIT = 20;
const SEASON_READ_CONCURRENCY = 4;

type MovieStub = {
  mediaType: 'movie';
  ratingKey: string;
  combinedFileSize: number | null;
};

type EpisodeStub = {
  mediaType: 'episode';
  ratingKey: string;
  libraryKey: string;
  showRatingKey: string;
  seasonRatingKey: string;
  seasonIndex: number;
  episodeIndex: number;
  episodeTitle: string;
  combinedFileSize: number | null;
};

type SeasonStub = {
  mediaType: 'season';
  libraryKey: string;
  showRatingKey: string;
  seasonRatingKey: string;
  seasonIndex: number;
  combinedFileSize: number | null;
  duplicateGroupCount: number;
  episodes: EpisodeStub[];
};

type ListStub = MovieStub | SeasonStub;

// Movies with 2+ synced Media versions — Plex's own multi-version grouping. TV episodes
// with 2+ synced versions the same way, but see episodeMediaVersions in db/schema.ts:
// that table only ever holds genuine duplicates (filtered at write time), so grouping
// by episodeRatingKey there always yields count >= 2 — the HAVING clause below is
// defensive insurance, not the primary filter, for episodes.
// Deliberately not filtered by watch/stale status: lastViewedAt/viewCount are tracked
// per item, never per Media version, so which version was actually watched is never
// knowable — see CLAUDE.md's Duplicate detection section.
router.get('/', async (c) => {
  const rawType = c.req.query('type');
  const type = rawType === 'movie' || rawType === 'tv' ? rawType : 'all';
  const wantMovies = type !== 'tv';
  const wantTv = type !== 'movie';
  const rawComparison = c.req.query('comparison');
  const comparison: DuplicateComparisonFilter =
    rawComparison === 'same-profile' || rawComparison === 'different' ||
      rawComparison === 'unknown'
      ? rawComparison
      : 'all';

  const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 50 : Math.min(rawLimit, 200);
  const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
  const parsedSearch = parseSearchQuery(c.req.query('search'));
  if ('error' in parsedSearch) return c.json({ error: parsedSearch.error }, 400);
  const { search } = parsedSearch;

  const movieSearchCond = search.length >= 2
    ? sql`exists (
        select 1 from ${items}
        where ${items.serverId} = ${itemMediaVersions.serverId}
          and ${items.ratingKey} = ${itemMediaVersions.itemRatingKey}
          and instr(lower(${items.title}), lower(${search})) > 0
      )`
    : undefined;
  // Episode searches include both the episode title and its parent show title, matching
  // the two pieces of identity displayed in the duplicate-groups table.
  const episodeSearchCond = search.length >= 2
    ? or(
      sql`instr(lower(${episodeMediaVersions.episodeTitle}), lower(${search})) > 0`,
      sql`exists (
        select 1 from ${items}
        where ${items.serverId} = ${episodeMediaVersions.serverId}
          and ${items.ratingKey} = ${episodeMediaVersions.showRatingKey}
          and instr(lower(${items.title}), lower(${search})) > 0
      )`,
    )
    : undefined;
  // `episode_media_versions` is populated only for genuine duplicates during sync, but a
  // durable version deletion can temporarily leave the retained singleton projection
  // behind until the next full sync. Keep that residual row out of every listing path.
  const episodeStillHasDuplicates = sql`(
    select count(*) from episode_media_versions as duplicate_versions
    where duplicate_versions.server_id = ${episodeMediaVersions.serverId}
      and duplicate_versions.episode_rating_key = ${episodeMediaVersions.episodeRatingKey}
  ) >= 2`;

  const serverId = c.get('activeServerId');
  if (serverId === null) {
    return c.json(
      {
        search,
        limit,
        offset,
        total: 0,
        duplicateGroupTotal: 0,
        groups: [],
      } satisfies DuplicatesResponse,
    );
  }

  // TV entries are paginated by season, so rank and cap seasons in SQL. Applying the
  // cap to episodes first can cut a season in half and understate both its size and its
  // duplicate count.
  const fetchLimit = GROUP_FETCH_CAP;

  const [movieStubRows, seasonStubRows] = await Promise.all([
    wantMovies
      ? db.select({
        itemRatingKey: itemMediaVersions.itemRatingKey,
        combinedFileSize: sql<string | null>`cast(sum(${itemMediaVersions.fileSize}) as text)`,
      })
        .from(itemMediaVersions)
        .where(and(
          eq(itemMediaVersions.serverId, serverId),
          not(movieRootIsWorkflowOwned(
            serverId,
            sql`${itemMediaVersions.libraryKey}`,
            sql`${itemMediaVersions.itemRatingKey}`,
          )),
          movieSearchCond,
        ))
        .groupBy(itemMediaVersions.itemRatingKey)
        .having(HAS_DUPLICATE_VERSIONS)
        .orderBy(desc(sql`sum(${itemMediaVersions.fileSize})`))
        .limit(fetchLimit)
      : Promise.resolve([]),
    wantTv
      ? db.select({
        libraryKey: episodeMediaVersions.libraryKey,
        showRatingKey: episodeMediaVersions.showRatingKey,
        seasonRatingKey: episodeMediaVersions.seasonRatingKey,
        seasonIndex: episodeMediaVersions.seasonIndex,
        combinedFileSize: sql<string | null>`cast(
          case
            when count(${episodeMediaVersions.fileSize}) = count(*)
              then sum(${episodeMediaVersions.fileSize})
            else null
          end as text
        )`,
        duplicateGroupCount: sql<number>`count(distinct ${episodeMediaVersions.episodeRatingKey})`,
      })
        .from(episodeMediaVersions)
        .where(and(
          eq(episodeMediaVersions.serverId, serverId),
          not(episodeRootIsWorkflowOwned(
            serverId,
            sql`${episodeMediaVersions.libraryKey}`,
            sql`${episodeMediaVersions.episodeRatingKey}`,
            sql`${episodeMediaVersions.showRatingKey}`,
          )),
          episodeSearchCond,
          episodeStillHasDuplicates,
        ))
        .groupBy(
          episodeMediaVersions.libraryKey,
          episodeMediaVersions.showRatingKey,
          episodeMediaVersions.seasonRatingKey,
          episodeMediaVersions.seasonIndex,
        )
        .having(HAS_DUPLICATE_VERSIONS)
        .orderBy(desc(sql`sum(${episodeMediaVersions.fileSize})`))
        .limit(fetchLimit)
      : Promise.resolve([]),
  ]);

  const movieStubs = movieStubRows.map((s): MovieStub => ({
    mediaType: 'movie',
    ratingKey: s.itemRatingKey,
    combinedFileSize: s.combinedFileSize != null ? Number(s.combinedFileSize) : null,
  }));
  const seasonStubs = seasonStubRows.map((s): SeasonStub => ({
    mediaType: 'season',
    libraryKey: s.libraryKey,
    showRatingKey: s.showRatingKey,
    seasonRatingKey: s.seasonRatingKey,
    seasonIndex: s.seasonIndex,
    combinedFileSize: s.combinedFileSize != null ? Number(s.combinedFileSize) : null,
    duplicateGroupCount: s.duplicateGroupCount,
    episodes: [],
  }));

  const loadEligibleSeasonEpisodeKeys = async (
    season: SeasonStub,
    offset = 0,
    limit = SEASON_EPISODE_READ_PAGE_SIZE,
  ): Promise<string[]> => {
    const rows = await db.select({
      ratingKey: episodeMediaVersions.episodeRatingKey,
      episodeIndex: episodeMediaVersions.episodeIndex,
    }).from(episodeMediaVersions).where(and(
      eq(episodeMediaVersions.serverId, serverId),
      eq(episodeMediaVersions.libraryKey, season.libraryKey),
      eq(episodeMediaVersions.showRatingKey, season.showRatingKey),
      eq(episodeMediaVersions.seasonRatingKey, season.seasonRatingKey),
      not(episodeRootIsWorkflowOwned(
        serverId,
        sql`${episodeMediaVersions.libraryKey}`,
        sql`${episodeMediaVersions.episodeRatingKey}`,
        sql`${episodeMediaVersions.showRatingKey}`,
      )),
      episodeSearchCond,
      episodeStillHasDuplicates,
    )).groupBy(
      episodeMediaVersions.episodeRatingKey,
      episodeMediaVersions.episodeIndex,
    ).having(HAS_DUPLICATE_VERSIONS).orderBy(
      episodeMediaVersions.episodeIndex,
      episodeMediaVersions.episodeRatingKey,
    ).limit(limit).offset(offset);
    return rows.map((row) => row.ratingKey);
  };

  const loadEpisodeVersionRows = async (episodeKeys: string[]) => {
    const pages = await mapWithConcurrency(
      keyBatches(episodeKeys),
      SEASON_READ_CONCURRENCY,
      (batch) =>
        db.select().from(episodeMediaVersions).where(and(
          eq(episodeMediaVersions.serverId, serverId),
          inArray(episodeMediaVersions.episodeRatingKey, batch),
        )),
    );
    return pages.flat();
  };

  const loadSeasonPassEpisodeKeys = async (season: SeasonStub): Promise<string[]> => {
    if (comparison === 'all') {
      return loadEligibleSeasonEpisodeKeys(season, 0, SEASON_LIST_EPISODE_SAMPLE_LIMIT);
    }
    const matchingKeys: string[] = [];
    let offset = 0;
    while (matchingKeys.length < SEASON_LIST_EPISODE_SAMPLE_LIMIT) {
      const episodeKeys = await loadEligibleSeasonEpisodeKeys(season, offset);
      if (episodeKeys.length === 0) break;
      const versionRows = await loadEpisodeVersionRows(episodeKeys);
      const versionsByEpisode = groupVersions(versionRows, (row) => row.episodeRatingKey);
      for (const episode of episodeStubsFromRows(versionRows)) {
        if (
          compareDuplicateVersions(versionsByEpisode.get(episode.ratingKey) ?? []).kind ===
            comparison
        ) {
          matchingKeys.push(episode.ratingKey);
          if (matchingKeys.length === SEASON_LIST_EPISODE_SAMPLE_LIMIT) break;
        }
      }
      offset += episodeKeys.length;
      if (episodeKeys.length < SEASON_EPISODE_READ_PAGE_SIZE) break;
    }
    return matchingKeys;
  };

  let preloadedMovieVersionRows: Array<typeof itemMediaVersions.$inferSelect> | null = null;
  let preloadedEpisodeVersionRows: Array<typeof episodeMediaVersions.$inferSelect> | null = null;
  let filteredMovieStubs = movieStubs;
  let filteredSeasonStubs = seasonStubs;
  if (comparison !== 'all') {
    const movieKeys = movieStubs.map((stub) => stub.ratingKey);
    preloadedMovieVersionRows = await loadMovieVersionRows(serverId, movieKeys);
    const allMovieVersions = groupVersions(preloadedMovieVersionRows, (row) => row.itemRatingKey);
    filteredMovieStubs = movieStubs.filter((stub) => {
      const versions = allMovieVersions.get(stub.ratingKey) ?? [];
      return compareDuplicateVersions(versions).kind === comparison;
    });
    filteredSeasonStubs = [];
    for (const seasonBatch of arrayBatches(seasonStubs, SEASON_FILTER_BATCH_SIZE)) {
      const summaries = await mapWithConcurrency(
        seasonBatch,
        SEASON_READ_CONCURRENCY,
        async (season) => {
          let offset = 0;
          let duplicateGroupCount = 0;
          let combinedFileSize: number | null = 0;
          while (true) {
            const episodeKeys = await loadEligibleSeasonEpisodeKeys(season, offset);
            if (episodeKeys.length === 0) break;
            const versionRows = await loadEpisodeVersionRows(episodeKeys);
            const versionsByEpisode = groupVersions(versionRows, (row) => row.episodeRatingKey);
            for (const episode of episodeStubsFromRows(versionRows)) {
              const versions = versionsByEpisode.get(episode.ratingKey) ?? [];
              if (compareDuplicateVersions(versions).kind !== comparison) continue;
              duplicateGroupCount++;
              combinedFileSize = combinedFileSize === null || episode.combinedFileSize === null
                ? null
                : combinedFileSize + episode.combinedFileSize;
            }
            offset += episodeKeys.length;
            if (episodeKeys.length < SEASON_EPISODE_READ_PAGE_SIZE) break;
          }
          return { season, duplicateGroupCount, combinedFileSize };
        },
      );
      for (const { season, duplicateGroupCount, combinedFileSize } of summaries) {
        if (duplicateGroupCount === 0) continue;
        filteredSeasonStubs.push({
          ...season,
          episodes: [],
          duplicateGroupCount,
          combinedFileSize,
        });
      }
    }
  }

  const listStubs: ListStub[] = [...filteredMovieStubs, ...filteredSeasonStubs].sort(
    (a, b) => (b.combinedFileSize ?? 0) - (a.combinedFileSize ?? 0),
  );
  const total = listStubs.length;
  const duplicateGroupTotal = filteredMovieStubs.length +
    filteredSeasonStubs.reduce((total, season) => total + season.duplicateGroupCount, 0);
  const page = listStubs.slice(offset, offset + limit);
  const pageMovieKeys = page.filter((s) => s.mediaType === 'movie').map((s) => s.ratingKey);
  const pageSeasons = page.filter((stub): stub is SeasonStub => stub.mediaType === 'season');
  const pageSeasonEpisodeKeys = await mapWithConcurrency(
    pageSeasons,
    SEASON_READ_CONCURRENCY,
    (season) => loadSeasonPassEpisodeKeys(season),
  );
  preloadedEpisodeVersionRows = await loadEpisodeVersionRows(pageSeasonEpisodeKeys.flat());
  const pageEpisodeVersions = groupVersions(
    preloadedEpisodeVersionRows,
    (row) => row.episodeRatingKey,
  );
  const episodesBySeason = new Map<string, EpisodeStub[]>();
  for (const episode of episodeStubsFromRows(preloadedEpisodeVersionRows)) {
    if (
      comparison !== 'all' &&
      compareDuplicateVersions(pageEpisodeVersions.get(episode.ratingKey) ?? []).kind !== comparison
    ) continue;
    const episodes = episodesBySeason.get(episode.seasonRatingKey) ?? [];
    episodes.push(episode);
    episodesBySeason.set(episode.seasonRatingKey, episodes);
  }
  for (const stub of page) {
    if (stub.mediaType === 'season') {
      stub.episodes = episodesBySeason.get(stub.seasonRatingKey) ?? [];
    }
  }
  const pageEpisodeKeys = page.flatMap((stub) =>
    stub.mediaType === 'season' ? stub.episodes.map((episode) => episode.ratingKey) : []
  );

  const [movieItemRows, movieVersionRows, episodeVersionRows] = await Promise.all([
    pageMovieKeys.length === 0 ? [] : db.select({
      ratingKey: items.ratingKey,
      libraryKey: items.libraryKey,
      title: items.title,
      year: items.year,
      thumb: items.thumb,
    })
      .from(items)
      .where(and(eq(items.serverId, serverId), inArray(items.ratingKey, pageMovieKeys))),
    pageMovieKeys.length === 0
      ? []
      : preloadedMovieVersionRows !== null
      ? preloadedMovieVersionRows.filter((row) => pageMovieKeys.includes(row.itemRatingKey))
      : db.select().from(itemMediaVersions)
        .where(
          and(
            eq(itemMediaVersions.serverId, serverId),
            inArray(itemMediaVersions.itemRatingKey, pageMovieKeys),
          ),
        ),
    pageEpisodeKeys.length === 0
      ? []
      : preloadedEpisodeVersionRows !== null
      ? preloadedEpisodeVersionRows.filter((row) => pageEpisodeKeys.includes(row.episodeRatingKey))
      : db.select().from(episodeMediaVersions)
        .where(
          and(
            eq(episodeMediaVersions.serverId, serverId),
            inArray(episodeMediaVersions.episodeRatingKey, pageEpisodeKeys),
          ),
        ),
  ]);

  const movieItemByKey = new Map(movieItemRows.map((r) => [r.ratingKey, r]));
  const movieVersionsByKey = groupVersions(movieVersionRows, (v) => v.itemRatingKey);
  const episodeVersionsByKey = groupVersions(episodeVersionRows, (v) => v.episodeRatingKey);

  const showKeys = [...new Set(episodeVersionRows.map((v) => v.showRatingKey))];
  const showRows = showKeys.length === 0 ? [] : await db.select({
    ratingKey: items.ratingKey,
    title: items.title,
    thumb: items.thumb,
  })
    .from(items)
    .where(and(eq(items.serverId, serverId), inArray(items.ratingKey, showKeys)));
  const showByKey = new Map(showRows.map((r) => [r.ratingKey, r]));

  const groups = page
    .map((stub): DuplicateListGroup | null => {
      if (stub.mediaType === 'movie') {
        const item = movieItemByKey.get(stub.ratingKey);
        if (!item) return null;
        return {
          mediaType: 'movie',
          libraryKey: item.libraryKey,
          ratingKey: stub.ratingKey,
          title: item.title,
          year: item.year,
          thumb: item.thumb,
          combinedFileSize: stub.combinedFileSize,
          versions: movieVersionsByKey.get(stub.ratingKey) ?? [],
        } satisfies DuplicateMovieGroup;
      }
      const show = showByKey.get(stub.showRatingKey);
      const episodes = stub.episodes.map((episode): DuplicateEpisodeGroup | null => {
        const versions = episodeVersionsByKey.get(episode.ratingKey) ?? [];
        if (versions.length < 2) return null;
        return {
          mediaType: 'episode',
          libraryKey: episode.libraryKey,
          episodeRatingKey: episode.ratingKey,
          showRatingKey: episode.showRatingKey,
          seasonRatingKey: episode.seasonRatingKey,
          showTitle: show?.title ?? 'Unknown show',
          showThumb: show?.thumb ?? null,
          seasonIndex: episode.seasonIndex,
          episodeIndex: episode.episodeIndex,
          episodeTitle: episode.episodeTitle,
          combinedFileSize: episode.combinedFileSize,
          versions,
        } satisfies DuplicateEpisodeGroup;
      }).filter((episode): episode is DuplicateEpisodeGroup => episode !== null)
        .sort((a, b) => a.episodeIndex - b.episodeIndex);
      if (episodes.length === 0) return null;
      return {
        mediaType: 'season',
        libraryKey: stub.libraryKey,
        showRatingKey: stub.showRatingKey,
        seasonRatingKey: stub.seasonRatingKey,
        showTitle: show?.title ?? 'Unknown show',
        showThumb: show?.thumb ?? null,
        seasonIndex: stub.seasonIndex,
        duplicateGroupCount: stub.duplicateGroupCount,
        combinedFileSize: stub.combinedFileSize,
        comparisonSummary: summarizeDuplicateComparisons(
          episodes.map((episode) => compareDuplicateVersions(episode.versions)),
        ),
        episodes,
      } satisfies DuplicateSeasonGroup;
    })
    .filter((g): g is DuplicateListGroup => g !== null);

  return c.json(
    {
      search,
      limit,
      offset,
      total,
      duplicateGroupTotal,
      groups,
    } satisfies DuplicatesResponse,
  );
});

function episodeStubsFromRows(
  rows: Array<typeof episodeMediaVersions.$inferSelect>,
): EpisodeStub[] {
  const grouped = new Map<string, Array<typeof episodeMediaVersions.$inferSelect>>();
  for (const row of rows) {
    const versions = grouped.get(row.episodeRatingKey) ?? [];
    versions.push(row);
    grouped.set(row.episodeRatingKey, versions);
  }
  return [...grouped.entries()].flatMap(([ratingKey, versions]) => {
    if (versions.length < 2) return [];
    const first = versions[0]!;
    const sizes = versions.map((version) => version.fileSize);
    return [{
      mediaType: 'episode',
      ratingKey,
      libraryKey: first.libraryKey,
      showRatingKey: first.showRatingKey,
      seasonRatingKey: first.seasonRatingKey,
      seasonIndex: first.seasonIndex,
      episodeIndex: first.episodeIndex,
      episodeTitle: first.episodeTitle,
      combinedFileSize: sizes.every((size) => size !== null)
        ? sizes.reduce<number>((total, size) => total + (size ?? 0), 0)
        : null,
    }];
  });
}

function groupVersions<T extends Parameters<typeof mediaVersionFromRow>[0]>(
  rows: T[],
  keyOf: (row: T) => string,
): Map<string, ReturnType<typeof mediaVersionFromRow>[]> {
  const map = new Map<string, ReturnType<typeof mediaVersionFromRow>[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key) ?? [];
    list.push(mediaVersionFromRow(row));
    map.set(key, list);
  }
  return map;
}

export default router;

function keyBatches(keys: string[]): string[][] {
  return arrayBatches(keys, VERSION_FILTER_BATCH_SIZE);
}

function arrayBatches<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    batches.push(values.slice(start, start + size));
  }
  return batches;
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await map(values[index]!);
      }
    },
  ));
  return results;
}

async function loadMovieVersionRows(
  serverId: number,
  keys: string[],
): Promise<Array<typeof itemMediaVersions.$inferSelect>> {
  const pages = await Promise.all(
    keyBatches(keys).map((batch) =>
      db.select().from(itemMediaVersions).where(and(
        eq(itemMediaVersions.serverId, serverId),
        inArray(itemMediaVersions.itemRatingKey, batch),
      ))
    ),
  );
  return pages.flat();
}
