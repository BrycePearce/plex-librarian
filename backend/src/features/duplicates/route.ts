import { Hono } from 'hono';
import { db, type SqliteClient, withTransaction } from '../../db/index.ts';
import { episodeMediaVersions, itemMediaVersions, items } from '../../db/schema.ts';
import { episodeVersionsByEpisode, itemByRatingKey, mediaVersionsByItem } from '../../db/scope.ts';
import { createPlexClient, PlexDeleteError } from '../../integrations/plex/index.ts';
import { logEvents } from '../events/service.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import listRoute from './listRoute.ts';
import type { DeleteMediaVersionResponse } from '@plex-librarian/shared/types.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);
router.route('/', listRoute);

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
