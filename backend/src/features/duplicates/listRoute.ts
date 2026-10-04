import { Hono } from 'hono';
import { and, desc, eq, inArray, not, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { episodeMediaVersions, itemMediaVersions, items, seasons } from '../../db/schema.ts';
import { contentIsNotIgnored, HAS_DUPLICATE_VERSIONS } from '../../db/scope.ts';
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
  episodeRootIsWorkflowOwnedForRead,
  movieRootIsWorkflowOwnedForRead,
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
  totalEpisodeCount: number | null;
  combinedFileSize: number | null;
  reclaimableFileSize: number | null;
  duplicateGroupCount: number;
  episodes: EpisodeStub[];
};

type ListStub = MovieStub | SeasonStub;

type SeasonEpisodeKey = {
  ratingKey: string;
  seasonRatingKey: string;
  episodeIndex: number;
};

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

  // Aggregate once per episode before rolling up to a season. The second grouping makes
  // `sum(all versions) - sum(largest version per episode)` exact without loading every
  // episode's version rows into application memory. Both episode queries use HAVING to
  // exclude retained singleton projections left by deletion until the next sync; an
  // additional correlated version count for each input row would repeat that work.
  const eligibleEpisodeRows = db.select({
    libraryKey: episodeMediaVersions.libraryKey,
    showRatingKey: episodeMediaVersions.showRatingKey,
    seasonRatingKey: episodeMediaVersions.seasonRatingKey,
    seasonIndex: episodeMediaVersions.seasonIndex,
    episodeRatingKey: episodeMediaVersions.episodeRatingKey,
    versionCount: sql<number>`count(*)`.as('version_count'),
    knownFileSizeCount: sql<number>`count(${episodeMediaVersions.fileSize})`.as(
      'known_file_size_count',
    ),
    combinedFileSize: sql<number>`sum(${episodeMediaVersions.fileSize})`.as(
      'combined_file_size',
    ),
    retainedFileSize: sql<number>`max(${episodeMediaVersions.fileSize})`.as(
      'retained_file_size',
    ),
  }).from(episodeMediaVersions).where(and(
    eq(episodeMediaVersions.serverId, serverId),
    contentIsNotIgnored(serverId, episodeMediaVersions.showRatingKey),
    not(episodeRootIsWorkflowOwnedForRead(
      serverId,
      sql`${episodeMediaVersions.libraryKey}`,
      sql`${episodeMediaVersions.episodeRatingKey}`,
      sql`${episodeMediaVersions.showRatingKey}`,
      sql`${episodeMediaVersions.seasonRatingKey}`,
    )),
    episodeSearchCond,
  )).groupBy(
    episodeMediaVersions.libraryKey,
    episodeMediaVersions.showRatingKey,
    episodeMediaVersions.seasonRatingKey,
    episodeMediaVersions.seasonIndex,
    episodeMediaVersions.episodeRatingKey,
  ).having(HAS_DUPLICATE_VERSIONS).as('eligible_episode_rows');

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
          contentIsNotIgnored(serverId, itemMediaVersions.itemRatingKey),
          not(movieRootIsWorkflowOwnedForRead(
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
        libraryKey: eligibleEpisodeRows.libraryKey,
        showRatingKey: eligibleEpisodeRows.showRatingKey,
        seasonRatingKey: eligibleEpisodeRows.seasonRatingKey,
        seasonIndex: eligibleEpisodeRows.seasonIndex,
        totalEpisodeCount: seasons.leafCount,
        combinedFileSize: sql<string | null>`cast(
          case
            when sum(${eligibleEpisodeRows.knownFileSizeCount}) = sum(${eligibleEpisodeRows.versionCount})
              then sum(${eligibleEpisodeRows.combinedFileSize})
            else null
          end as text
        )`,
        reclaimableFileSize: sql<string | null>`cast(
          case
            when sum(${eligibleEpisodeRows.knownFileSizeCount}) = sum(${eligibleEpisodeRows.versionCount})
              then sum(${eligibleEpisodeRows.combinedFileSize} - ${eligibleEpisodeRows.retainedFileSize})
            else null
          end as text
        )`,
        duplicateGroupCount: sql<number>`count(*)`,
      })
        .from(eligibleEpisodeRows)
        .leftJoin(
          seasons,
          and(
            eq(seasons.serverId, serverId),
            eq(seasons.ratingKey, eligibleEpisodeRows.seasonRatingKey),
          ),
        )
        .groupBy(
          eligibleEpisodeRows.libraryKey,
          eligibleEpisodeRows.showRatingKey,
          eligibleEpisodeRows.seasonRatingKey,
          eligibleEpisodeRows.seasonIndex,
          seasons.leafCount,
        )
        .orderBy(desc(sql`sum(${eligibleEpisodeRows.combinedFileSize})`))
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
    totalEpisodeCount: s.totalEpisodeCount,
    combinedFileSize: s.combinedFileSize != null ? Number(s.combinedFileSize) : null,
    reclaimableFileSize: s.reclaimableFileSize != null ? Number(s.reclaimableFileSize) : null,
    duplicateGroupCount: s.duplicateGroupCount,
    episodes: [],
  }));

  const loadEligibleSeasonEpisodeKeys = async (
    season: SeasonStub,
    offset = 0,
    limit = SEASON_EPISODE_READ_PAGE_SIZE,
  ): Promise<string[]> => {
    // GROUP BY otherwise makes SQLite prefer the episode index's server-only
    // prefix, scanning every duplicate episode once for each candidate season.
    // This lookup has an exact season identity; keep the read scoped to that season.
    const rows = await db.select({
      ratingKey: sql<string>`${episodeMediaVersions.episodeRatingKey}`,
      episodeIndex: sql<number>`${episodeMediaVersions.episodeIndex}`,
    }).from(sql`${episodeMediaVersions} indexed by episode_media_versions_season_idx`).where(and(
      eq(episodeMediaVersions.serverId, serverId),
      eq(episodeMediaVersions.libraryKey, season.libraryKey),
      eq(episodeMediaVersions.showRatingKey, season.showRatingKey),
      eq(episodeMediaVersions.seasonRatingKey, season.seasonRatingKey),
      not(episodeRootIsWorkflowOwnedForRead(
        serverId,
        season.libraryKey,
        sql`${episodeMediaVersions.episodeRatingKey}`,
        sql`${episodeMediaVersions.showRatingKey}`,
        sql`${episodeMediaVersions.seasonRatingKey}`,
      )),
      episodeSearchCond,
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

  const loadSeasonBatchEpisodeKeys = async (
    batch: SeasonStub[],
    cursor?: SeasonEpisodeKey,
  ): Promise<SeasonEpisodeKey[]> => {
    // Stream one bounded key page across the season batch. Each statement evaluates
    // current workflow ownership once, instead of rebuilding its root sets per season.
    return await db.select({
      ratingKey: sql<string>`${episodeMediaVersions.episodeRatingKey}`,
      seasonRatingKey: sql<string>`${episodeMediaVersions.seasonRatingKey}`,
      episodeIndex: sql<number>`${episodeMediaVersions.episodeIndex}`,
    }).from(sql`${episodeMediaVersions} indexed by episode_media_versions_season_idx`).where(and(
      eq(episodeMediaVersions.serverId, serverId),
      inArray(episodeMediaVersions.seasonRatingKey, batch.map((season) => season.seasonRatingKey)),
      or(...batch.map((season) =>
        and(
          eq(episodeMediaVersions.libraryKey, season.libraryKey),
          eq(episodeMediaVersions.showRatingKey, season.showRatingKey),
          eq(episodeMediaVersions.seasonRatingKey, season.seasonRatingKey),
        )
      )),
      not(episodeRootIsWorkflowOwnedForRead(
        serverId,
        sql`${episodeMediaVersions.libraryKey}`,
        sql`${episodeMediaVersions.episodeRatingKey}`,
        sql`${episodeMediaVersions.showRatingKey}`,
        sql`${episodeMediaVersions.seasonRatingKey}`,
      )),
      episodeSearchCond,
      cursor
        ? sql`(${episodeMediaVersions.seasonRatingKey}, ${episodeMediaVersions.episodeIndex},
            ${episodeMediaVersions.episodeRatingKey}) >
          (${cursor.seasonRatingKey}, ${cursor.episodeIndex}, ${cursor.ratingKey})`
        : undefined,
    )).groupBy(
      episodeMediaVersions.seasonRatingKey,
      episodeMediaVersions.episodeRatingKey,
      episodeMediaVersions.episodeIndex,
    ).having(HAS_DUPLICATE_VERSIONS).orderBy(
      episodeMediaVersions.seasonRatingKey,
      episodeMediaVersions.episodeIndex,
      episodeMediaVersions.episodeRatingKey,
    ).limit(SEASON_EPISODE_READ_PAGE_SIZE);
  };

  let preloadedMovieVersionRows: Array<typeof itemMediaVersions.$inferSelect> | null = null;
  // Keep only preview keys while computing comparison totals. The page can hydrate its
  // bounded sample directly instead of walking and comparing each visible season twice.
  const previewKeysBySeason = new Map<string, string[]>();
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
      const summaries = new Map(seasonBatch.map((season) => [season.seasonRatingKey, {
        season,
        duplicateGroupCount: 0,
        combinedFileSize: 0 as number | null,
        reclaimableFileSize: 0 as number | null,
        previewKeys: [] as string[],
      }]));
      let cursor: SeasonEpisodeKey | undefined;
      while (true) {
        const episodeKeys = await loadSeasonBatchEpisodeKeys(seasonBatch, cursor);
        if (episodeKeys.length === 0) break;
        const versionRows = await loadEpisodeVersionRows(
          episodeKeys.map((episode) => episode.ratingKey),
        );
        const versionsByEpisode = groupVersions(versionRows, (row) => row.episodeRatingKey);
        const episodesByKey = new Map(
          episodeStubsFromRows(versionRows).map((episode) => [episode.ratingKey, episode]),
        );
        const seenKeys = new Set<string>();
        // Keep the key page's numeric episode order when choosing the bounded preview.
        for (const key of episodeKeys) {
          if (seenKeys.has(key.ratingKey)) continue;
          seenKeys.add(key.ratingKey);
          const episode = episodesByKey.get(key.ratingKey);
          if (!episode || episode.seasonRatingKey !== key.seasonRatingKey) continue;
          const versions = versionsByEpisode.get(episode.ratingKey) ?? [];
          if (compareDuplicateVersions(versions).kind !== comparison) continue;
          const summary = summaries.get(key.seasonRatingKey)!;
          if (summary.previewKeys.length < SEASON_LIST_EPISODE_SAMPLE_LIMIT) {
            summary.previewKeys.push(episode.ratingKey);
          }
          summary.duplicateGroupCount++;
          summary.combinedFileSize =
            summary.combinedFileSize === null || episode.combinedFileSize === null
              ? null
              : summary.combinedFileSize + episode.combinedFileSize;
          const sizes = versions.map((version) => version.fileSize);
          summary.reclaimableFileSize = summary.reclaimableFileSize === null ||
              sizes.some((size) => size === null)
            ? null
            : summary.reclaimableFileSize +
              sizes.reduce<number>((total, size) => total + (size ?? 0), 0) -
              Math.max(...sizes.map((size) => size ?? 0));
        }
        cursor = episodeKeys.at(-1);
        if (episodeKeys.length < SEASON_EPISODE_READ_PAGE_SIZE) break;
      }
      for (
        const { season, duplicateGroupCount, combinedFileSize, reclaimableFileSize, previewKeys }
          of summaries.values()
      ) {
        if (duplicateGroupCount === 0) continue;
        previewKeysBySeason.set(season.seasonRatingKey, previewKeys);
        filteredSeasonStubs.push({
          ...season,
          episodes: [],
          duplicateGroupCount,
          combinedFileSize,
          reclaimableFileSize,
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
    (season) =>
      comparison === 'all'
        ? loadEligibleSeasonEpisodeKeys(season, 0, SEASON_LIST_EPISODE_SAMPLE_LIMIT)
        : Promise.resolve(previewKeysBySeason.get(season.seasonRatingKey) ?? []),
  );
  const preloadedEpisodeVersionRows = await loadEpisodeVersionRows(pageSeasonEpisodeKeys.flat());
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
  const pageMovieKeySet = new Set(pageMovieKeys);
  const pageEpisodeKeySet = new Set(pageEpisodeKeys);

  const [movieItemRows, movieVersionRows] = await Promise.all([
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
      ? preloadedMovieVersionRows.filter((row) => pageMovieKeySet.has(row.itemRatingKey))
      : db.select().from(itemMediaVersions)
        .where(
          and(
            eq(itemMediaVersions.serverId, serverId),
            inArray(itemMediaVersions.itemRatingKey, pageMovieKeys),
          ),
        ),
  ]);
  const episodeVersionRows = preloadedEpisodeVersionRows.filter((row) =>
    pageEpisodeKeySet.has(row.episodeRatingKey)
  );

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
        totalEpisodeCount: stub.totalEpisodeCount,
        duplicateGroupCount: stub.duplicateGroupCount,
        combinedFileSize: stub.combinedFileSize,
        reclaimableFileSize: stub.reclaimableFileSize,
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
