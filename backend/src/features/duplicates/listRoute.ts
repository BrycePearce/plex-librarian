import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { episodeMediaVersions, itemMediaVersions, items } from '../../db/schema.ts';
import { HAS_DUPLICATE_VERSIONS } from '../../db/scope.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import type {
  DuplicateEpisodeGroup,
  DuplicateGroup,
  DuplicateMovieGroup,
  DuplicatesResponse,
  MediaVersion,
} from '@plex-librarian/shared/types.ts';

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

type GroupStub = {
  mediaType: 'movie' | 'episode';
  ratingKey: string;
  combinedFileSize: number | null;
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

  const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 50 : Math.min(rawLimit, 200);
  const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const serverId = c.get('activeServerId');
  if (serverId === null) {
    return c.json({ limit, offset, total: 0, groups: [] } satisfies DuplicatesResponse);
  }

  // Any group ranked beyond position (offset + limit) can never appear on this page,
  // whether it's interleaved from the movie or episode list — the top (offset + limit)
  // merged-and-sorted results can only ever be drawn from the top (offset + limit) of
  // each source list (a group outside that range has too many same-type groups ranked
  // ahead of it to reach the merged page even in the best case). So fetching only that
  // many per type (rather than always GROUP_FETCH_CAP) is exact, not an approximation —
  // it just means shallow pages read and sort far fewer rows than deep ones.
  const fetchLimit = Math.min(GROUP_FETCH_CAP, offset + limit);

  const [movieStubRows, episodeStubRows] = await Promise.all([
    wantMovies
      ? db.select({
        itemRatingKey: itemMediaVersions.itemRatingKey,
        combinedFileSize: sql<string | null>`cast(sum(${itemMediaVersions.fileSize}) as text)`,
        // count(*) over () counts every HAVING-qualifying group before ORDER BY/LIMIT
        // truncate the result — one pass gets both the page and the true total,
        // instead of a second full GROUP BY/HAVING scan just to count groups.
        totalGroups: sql<number>`count(*) over ()`,
      })
        .from(itemMediaVersions)
        .where(eq(itemMediaVersions.serverId, serverId))
        .groupBy(itemMediaVersions.itemRatingKey)
        .having(HAS_DUPLICATE_VERSIONS)
        .orderBy(desc(sql`sum(${itemMediaVersions.fileSize})`))
        .limit(fetchLimit)
      : Promise.resolve([]),
    wantTv
      ? db.select({
        episodeRatingKey: episodeMediaVersions.episodeRatingKey,
        combinedFileSize: sql<string | null>`cast(sum(${episodeMediaVersions.fileSize}) as text)`,
        totalGroups: sql<number>`count(*) over ()`,
      })
        .from(episodeMediaVersions)
        .where(eq(episodeMediaVersions.serverId, serverId))
        .groupBy(episodeMediaVersions.episodeRatingKey)
        .having(HAS_DUPLICATE_VERSIONS)
        .orderBy(desc(sql`sum(${episodeMediaVersions.fileSize})`))
        .limit(fetchLimit)
      : Promise.resolve([]),
  ]);

  // Clamped to GROUP_FETCH_CAP per type to match what stubs (and therefore pages) can
  // actually contain — an uncapped total here would overstate the paginable set on a
  // server with more than GROUP_FETCH_CAP genuine duplicate groups of one type, leaving
  // the client's pagination pointing at offsets that always return an empty page.
  const total = Math.min(movieStubRows[0]?.totalGroups ?? 0, GROUP_FETCH_CAP) +
    Math.min(episodeStubRows[0]?.totalGroups ?? 0, GROUP_FETCH_CAP);

  const stubs: GroupStub[] = [
    ...movieStubRows.map((s): GroupStub => ({
      mediaType: 'movie',
      ratingKey: s.itemRatingKey,
      combinedFileSize: s.combinedFileSize != null ? Number(s.combinedFileSize) : null,
    })),
    ...episodeStubRows.map((s): GroupStub => ({
      mediaType: 'episode',
      ratingKey: s.episodeRatingKey,
      combinedFileSize: s.combinedFileSize != null ? Number(s.combinedFileSize) : null,
    })),
  ].sort((a, b) => (b.combinedFileSize ?? 0) - (a.combinedFileSize ?? 0));

  const page = stubs.slice(offset, offset + limit);
  const pageMovieKeys = page.filter((s) => s.mediaType === 'movie').map((s) => s.ratingKey);
  const pageEpisodeKeys = page.filter((s) => s.mediaType === 'episode').map((s) => s.ratingKey);

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
    pageMovieKeys.length === 0 ? [] : db.select().from(itemMediaVersions)
      .where(
        and(
          eq(itemMediaVersions.serverId, serverId),
          inArray(itemMediaVersions.itemRatingKey, pageMovieKeys),
        ),
      ),
    pageEpisodeKeys.length === 0 ? [] : db.select().from(episodeMediaVersions)
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
    .map((stub): DuplicateGroup | null => {
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
      const versionRows = episodeVersionRows.filter((v) => v.episodeRatingKey === stub.ratingKey);
      const first = versionRows[0];
      if (!first) return null;
      const show = showByKey.get(first.showRatingKey);
      return {
        mediaType: 'episode',
        libraryKey: first.libraryKey,
        episodeRatingKey: stub.ratingKey,
        showRatingKey: first.showRatingKey,
        showTitle: show?.title ?? 'Unknown show',
        showThumb: show?.thumb ?? null,
        seasonIndex: first.seasonIndex,
        episodeIndex: first.episodeIndex,
        episodeTitle: first.episodeTitle,
        combinedFileSize: stub.combinedFileSize,
        versions: episodeVersionsByKey.get(stub.ratingKey) ?? [],
      } satisfies DuplicateEpisodeGroup;
    })
    .filter((g): g is DuplicateGroup => g !== null);

  return c.json({ limit, offset, total, groups } satisfies DuplicatesResponse);
});

function groupVersions<
  T extends {
    mediaId: number;
    videoResolution: string | null;
    bitrate: number | null;
    videoCodec: string | null;
    container: string | null;
    fileSize: number | null;
  },
>(rows: T[], keyOf: (row: T) => string): Map<string, MediaVersion[]> {
  const map = new Map<string, MediaVersion[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key) ?? [];
    list.push({
      mediaId: row.mediaId,
      videoResolution: row.videoResolution,
      bitrate: row.bitrate,
      videoCodec: row.videoCodec,
      container: row.container,
      fileSize: row.fileSize,
    });
    map.set(key, list);
  }
  return map;
}

export default router;
