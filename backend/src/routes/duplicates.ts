import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type SqliteClient, withTransaction } from '../db/index.ts';
import { episodeMediaVersions, itemMediaVersions, items } from '../db/schema.ts';
import {
  episodeVersionsByEpisode,
  HAS_DUPLICATE_VERSIONS,
  itemByRatingKey,
  mediaVersionsByItem,
} from '../db/scope.ts';
import { createPlexClient, PlexDeleteError } from '../lib/plex.ts';
import { logEvents } from '../services/events.ts';
import { type ActiveServerVariables, withActiveServerId } from '../middleware/activeServer.ts';
import type {
  DeleteMediaVersionResponse,
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

// Calls Plex to delete one Media entry; a 404 means Plex already has no record of it
// (most likely deleted directly in Plex outside this app) and is treated as success,
// matching the precedent set by the bulk item-delete route in routes/libraries.ts.
// Rethrows any other failure so the caller can undo its already-committed local
// reservation (see the two routes below — the local delete must happen *before* this
// call for the last-version guard to have any teeth, so a failure here has to be
// compensated for, not just reported).
async function deletePlexMediaTolerating404(
  client: Awaited<ReturnType<typeof createPlexClient>>,
  ratingKey: string,
  mediaId: number,
): Promise<void> {
  try {
    await client.deleteMedia(ratingKey, mediaId);
  } catch (err) {
    if (!(err instanceof PlexDeleteError && err.status === 404)) throw err;
  }
}

// Re-inserts a version row this request removed as part of its local "reservation"
// (see below) after Plex failed to actually delete the underlying file — restores
// local state to match reality rather than leaving a version marked gone that's still
// on disk. INSERT OR IGNORE: if a concurrent full sync has already re-upserted this
// exact row (same server_id + media_id) in the meantime, the sync's fresher data wins.
function restoreItemMediaVersion(
  sqliteClient: SqliteClient,
  target: typeof itemMediaVersions.$inferSelect,
): void {
  sqliteClient.prepare(
    `INSERT OR IGNORE INTO item_media_versions
       (server_id, media_id, item_rating_key, library_key, video_resolution, bitrate,
        video_codec, container, file_size, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    target.serverId,
    target.mediaId,
    target.itemRatingKey,
    target.libraryKey,
    target.videoResolution,
    target.bitrate,
    target.videoCodec,
    target.container,
    target.fileSize,
    target.updatedAt,
  );
  sqliteClient.prepare(
    `UPDATE items SET file_size = (
       SELECT SUM(file_size) FROM item_media_versions WHERE server_id = ? AND item_rating_key = ?
     ) WHERE server_id = ? AND rating_key = ?`,
  ).run(target.serverId, target.itemRatingKey, target.serverId, target.itemRatingKey);
}

function restoreEpisodeMediaVersion(
  sqliteClient: SqliteClient,
  target: typeof episodeMediaVersions.$inferSelect,
): void {
  sqliteClient.prepare(
    `INSERT OR IGNORE INTO episode_media_versions
       (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key,
        library_key, episode_title, episode_index, season_index, video_resolution,
        bitrate, video_codec, container, file_size, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    target.serverId,
    target.mediaId,
    target.episodeRatingKey,
    target.seasonRatingKey,
    target.showRatingKey,
    target.libraryKey,
    target.episodeTitle,
    target.episodeIndex,
    target.seasonIndex,
    target.videoResolution,
    target.bitrate,
    target.videoCodec,
    target.container,
    target.fileSize,
    target.updatedAt,
  );
  const freed = target.fileSize ?? 0;
  sqliteClient.prepare(
    `UPDATE seasons SET file_size = COALESCE(file_size, 0) + ? WHERE server_id = ? AND rating_key = ?`,
  ).run(freed, target.serverId, target.seasonRatingKey);
  sqliteClient.prepare(
    `UPDATE items SET file_size = COALESCE(file_size, 0) + ?
     WHERE server_id = ? AND rating_key = ? AND type = 'show'`,
  ).run(freed, target.serverId, target.showRatingKey);
}

// Deletes a single Media version of a movie (one file) without touching its other
// versions or the item itself — distinct from DELETE /:key/items in routes/libraries.ts,
// which removes a whole item. Lives here rather than under /api/libraries because a
// media_id is already globally unique per server (the table's PK is
// (server_id, media_id)) — no library context is actually needed to address it, only
// to attribute the resulting activity-log entry, which is read back off the row itself.
router.delete('/movies/:ratingKey/media/:mediaId', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const mediaId = parseInt(c.req.param('mediaId'), 10);
  if (Number.isNaN(mediaId)) return c.json({ error: 'mediaId must be an integer' }, 400);

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'movie not found' }, 404);

  const [[item], versions] = await Promise.all([
    db.select({ title: items.title, libraryKey: items.libraryKey }).from(items)
      .where(itemByRatingKey(serverId, ratingKey))
      .limit(1),
    db.select().from(itemMediaVersions)
      .where(mediaVersionsByItem(serverId, ratingKey)),
  ]);
  if (!item) return c.json({ error: 'movie not found' }, 404);

  const target = versions.find((v) => v.mediaId === mediaId);
  if (!target) return c.json({ error: 'media version not found' }, 404);
  // Deleting the last remaining version is a different, existing flow (whole-item
  // delete via DELETE /:key/items in routes/libraries.ts) — this route only ever
  // removes a redundant copy. This check alone is a non-atomic fast path (the versions
  // read above and any write below aren't one transaction) — the reservation
  // immediately after is what actually enforces the guard.
  if (versions.length <= 1) {
    return c.json({
      error: 'cannot delete the last remaining version of an item — delete the item instead',
    }, 400);
  }

  // Reserves the deletion locally, atomically, BEFORE calling Plex: the DELETE's own
  // subquery re-checks the live version count at the moment the statement runs, so two
  // concurrent deletes for the same item's last two versions can't both pass the plain
  // check above and both proceed — whichever statement runs second observes the first's
  // row already gone and its subquery evaluates to false (@db/sqlite serializes every
  // statement through one connection, so there's no window for another request's write
  // to land between the subquery read and this DELETE). Must run before the Plex call:
  // once Plex has actually deleted a file there's no undoing it, so the guard only has
  // teeth if local state is reserved first.
  const reserved = withTransaction((sqliteClient) => {
    const changes = sqliteClient.prepare(
      `DELETE FROM item_media_versions
       WHERE server_id = ? AND media_id = ?
         AND (SELECT COUNT(*) FROM item_media_versions WHERE server_id = ? AND item_rating_key = ?) >= 2`,
    ).run(serverId, mediaId, serverId, ratingKey);
    if (changes > 0) {
      sqliteClient.prepare(
        `UPDATE items SET file_size = (
           SELECT SUM(file_size) FROM item_media_versions WHERE server_id = ? AND item_rating_key = ?
         ) WHERE server_id = ? AND rating_key = ?`,
      ).run(serverId, ratingKey, serverId, ratingKey);
    }
    return changes > 0;
  });
  if (!reserved) {
    return c.json({
      error: 'cannot delete the last remaining version of an item — delete the item instead',
    }, 400);
  }

  let client;
  try {
    client = await createPlexClient();
  } catch (err) {
    withTransaction((sqliteClient) => restoreItemMediaVersion(sqliteClient, target));
    return c.json({ error: err instanceof Error ? err.message : 'Plex is not configured' }, 502);
  }

  try {
    await deletePlexMediaTolerating404(client, ratingKey, mediaId);
  } catch (err) {
    // The reservation above already removed this version's local row — since Plex
    // never actually deleted the file (a real failure, not "already gone"), undo that
    // reservation rather than leave local state claiming a version is gone that's still
    // on disk.
    withTransaction((sqliteClient) => restoreItemMediaVersion(sqliteClient, target));
    return c.json({ error: err instanceof Error ? err.message : 'delete failed' }, 502);
  }

  const fileSizeFreed = target.fileSize ?? 0;
  await logEvents([{
    serverId,
    type: 'media.deleted',
    payload: { libraryKey: item.libraryKey, ratingKey, title: item.title, mediaId, fileSizeFreed },
  }]);

  return c.json({ fileSizeFreed } satisfies DeleteMediaVersionResponse);
});

// Deletes a single Media version of an episode — the TV counterpart to
// DELETE /movies/:ratingKey/media/:mediaId above. Can't reuse that route: episodes are
// never `items` rows (TV syncs at show granularity, see CLAUDE.md), so ownership here
// is checked entirely against episode_media_versions instead of items.
router.delete('/episodes/:ratingKey/media/:mediaId', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const mediaId = parseInt(c.req.param('mediaId'), 10);
  if (Number.isNaN(mediaId)) return c.json({ error: 'mediaId must be an integer' }, 400);

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'episode not found' }, 404);

  const versions = await db.select().from(episodeMediaVersions)
    .where(episodeVersionsByEpisode(serverId, ratingKey));
  if (versions.length === 0) return c.json({ error: 'episode not found' }, 404);

  const target = versions.find((v) => v.mediaId === mediaId);
  if (!target) return c.json({ error: 'media version not found' }, 404);
  // Deleting the last remaining version is a different, existing flow (whole-show
  // delete via DELETE /:key/items in routes/libraries.ts) — this route only ever
  // removes a redundant copy. Same non-atomic-fast-path caveat as the movie route
  // above; the reservation below is what actually enforces the guard.
  if (versions.length <= 1) {
    return c.json({
      error: 'cannot delete the last remaining version of an episode — delete the show instead',
    }, 400);
  }

  // See the movie route above for why this must be atomic and run before the Plex
  // call. Unlike that route, there's no complete source to re-SUM fileSize from: this
  // table only ever holds the small subset of episodes with duplicates, not every
  // episode, so seasons.file_size/items.file_size (rolled up once at sync time from
  // every episode's own combined-across-versions size) can't be recomputed from here.
  // Subtracting the freed amount is an approximation that self-corrects on the next
  // full sync — same spirit as syncShowSizes' own rollups.
  const freed = target.fileSize ?? 0;
  const reserved = withTransaction((sqliteClient) => {
    const changes = sqliteClient.prepare(
      `DELETE FROM episode_media_versions
       WHERE server_id = ? AND media_id = ?
         AND (SELECT COUNT(*) FROM episode_media_versions WHERE server_id = ? AND episode_rating_key = ?) >= 2`,
    ).run(serverId, mediaId, serverId, ratingKey);
    if (changes > 0) {
      sqliteClient.prepare(
        `UPDATE seasons SET file_size = MAX(0, COALESCE(file_size, 0) - ?)
         WHERE server_id = ? AND rating_key = ?`,
      ).run(freed, serverId, target.seasonRatingKey);
      sqliteClient.prepare(
        `UPDATE items SET file_size = MAX(0, COALESCE(file_size, 0) - ?)
         WHERE server_id = ? AND rating_key = ? AND type = 'show'`,
      ).run(freed, serverId, target.showRatingKey);
    }
    return changes > 0;
  });
  if (!reserved) {
    return c.json({
      error: 'cannot delete the last remaining version of an episode — delete the show instead',
    }, 400);
  }

  let client;
  try {
    client = await createPlexClient();
  } catch (err) {
    withTransaction((sqliteClient) => restoreEpisodeMediaVersion(sqliteClient, target));
    return c.json({ error: err instanceof Error ? err.message : 'Plex is not configured' }, 502);
  }

  try {
    await deletePlexMediaTolerating404(client, ratingKey, mediaId);
  } catch (err) {
    withTransaction((sqliteClient) => restoreEpisodeMediaVersion(sqliteClient, target));
    return c.json({ error: err instanceof Error ? err.message : 'delete failed' }, 502);
  }

  const [show] = await db.select({ title: items.title }).from(items)
    .where(itemByRatingKey(serverId, target.showRatingKey)).limit(1);
  const title = `${
    show?.title ?? 'Unknown show'
  } — S${target.seasonIndex}E${target.episodeIndex} "${target.episodeTitle}"`;

  await logEvents([{
    serverId,
    type: 'media.deleted',
    payload: { libraryKey: target.libraryKey, ratingKey, title, mediaId, fileSizeFreed: freed },
  }]);

  return c.json({ fileSizeFreed: freed } satisfies DeleteMediaVersionResponse);
});

export default router;
