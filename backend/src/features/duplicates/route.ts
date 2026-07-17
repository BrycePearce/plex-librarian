import { Hono } from 'hono';
import { db, type SqliteClient, withTransaction } from '../../db/index.ts';
import {
  arrDeleteAttempts,
  downloadFileDeleteAttempts,
  episodeMediaVersions,
  itemMediaVersions,
  items,
  torrentDeleteAttempts,
} from '../../db/schema.ts';
import { episodeVersionsByEpisode, itemByRatingKey, mediaVersionsByItem } from '../../db/scope.ts';
import { createPlexClient, PlexDeleteError } from '../../integrations/plex/index.ts';
import { logEvents } from '../events/service.ts';
import { recordMediaRemovals } from '../mediaRemovals/service.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import { tryAcquireLibraryOperation } from '../../services/libraryOperations.ts';
import { mediaRatingKeyIsPlaying } from '../mediaDeletion/activePlayback.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { getDownloadClientTargets } from '../mediaDeletion/targets.ts';
import {
  DownloadedFileCleanupError,
  executeDownloadedFileCleanup,
  resolveDownloadCleanup,
} from '../mediaDeletion/cleanup.ts';
import { orphanRootIdentity } from '../mediaDeletion/hardlinks.ts';
import { buildVersionDeletionPlan } from '../mediaDeletion/versionPlanning.ts';
import {
  loadAttemptedArrInstancesByItem,
  loadAttemptedDownloadJobKeysByItem,
  loadAttemptedOrphanFilesByItem,
} from '../mediaDeletion/planning.ts';
import { ArrApiError } from '../../integrations/arr/client.ts';
import listRoute from './listRoute.ts';
import type {
  DeleteMediaVersionResponse,
  DeleteMediaVersionsResponse,
  DeletionStageOutcome,
  VersionDeletionPreviewResponse,
} from '@plex-librarian/shared/types.ts';

function parseMediaId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function parseMediaIds(body: unknown): number[] | null {
  if (!body || typeof body !== 'object' || !('mediaIds' in body)) return null;
  const mediaIds = (body as { mediaIds?: unknown }).mediaIds;
  if (
    !Array.isArray(mediaIds) || mediaIds.length === 0 || mediaIds.length > 50 ||
    !mediaIds.every((value): value is number => Number.isSafeInteger(value) && value >= 0)
  ) return null;
  return [...new Set(mediaIds)];
}

function appendCleanupOutcomes(
  outcomes: DeletionStageOutcome[],
  result: {
    deletedJobs: Array<{ provider: string; instanceName: string; name: string }>;
    alreadyRemovedJobs: Array<{ provider: string; instanceName: string; name: string }>;
    deletedOrphanFiles: string[];
    alreadyRemovedOrphanFiles: string[];
  },
): void {
  for (const job of result.deletedJobs) {
    outcomes.push({
      system: job.provider,
      target: `${job.instanceName}: ${job.name}`,
      status: 'deleted',
    });
  }
  for (const job of result.alreadyRemovedJobs) {
    outcomes.push({
      system: job.provider,
      target: `${job.instanceName}: ${job.name}`,
      status: 'already-absent',
    });
  }
  for (const path of result.deletedOrphanFiles) {
    outcomes.push({ system: 'filesystem', target: path, status: 'deleted' });
  }
  for (const path of result.alreadyRemovedOrphanFiles) {
    outcomes.push({ system: 'filesystem', target: path, status: 'already-absent' });
  }
}

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
): Promise<boolean> {
  try {
    await client.deleteMedia(ratingKey, mediaId);
    return true;
  } catch (err) {
    if (err instanceof PlexDeleteError && err.status === 404) return false;
    throw err;
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

router.post('/movies/:ratingKey/media/deletion-preview', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const mediaIds = parseMediaIds(await c.req.json().catch(() => null));
  if (!mediaIds) return c.json({ error: 'mediaIds must contain between 1 and 50 integers' }, 400);
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'movie not found' }, 404);

  const [[item], versions] = await Promise.all([
    db.select({
      ratingKey: items.ratingKey,
      title: items.title,
      type: items.type,
      tmdbId: items.tmdbId,
      tvdbId: items.tvdbId,
      libraryKey: items.libraryKey,
    }).from(items).where(itemByRatingKey(serverId, ratingKey)).limit(1),
    db.select().from(itemMediaVersions).where(mediaVersionsByItem(serverId, ratingKey)),
  ]);
  if (!item || item.type !== 'movie') return c.json({ error: 'movie not found' }, 404);
  if (mediaIds.some((mediaId) => !versions.some((version) => version.mediaId === mediaId))) {
    return c.json({ error: 'one or more media versions were not found' }, 404);
  }

  try {
    const client = await createPlexClient();
    const [liveVersions, arrTargets, downloadTargets, attemptedKeys, attemptedOrphans] =
      await Promise.all([
        client.mediaVersionPathPreviews(ratingKey),
        getArrDeleteTargets(serverId, item.libraryKey),
        getDownloadClientTargets(serverId),
        loadAttemptedDownloadJobKeysByItem(serverId, [ratingKey]),
        loadAttemptedOrphanFilesByItem(serverId, [ratingKey]),
      ]);
    const cleanup = await resolveDownloadCleanup(
      ratingKey,
      item,
      arrTargets,
      downloadTargets,
      attemptedKeys.get(ratingKey),
      attemptedOrphans.get(ratingKey),
    );
    const attemptedArrInstances = await loadAttemptedArrInstancesByItem(
      serverId,
      [item],
      arrTargets.map((target) => target.instanceId),
    );
    const plan = await buildVersionDeletionPlan({
      mediaType: 'movie',
      item,
      selectedMediaIds: new Set(mediaIds),
      liveVersions,
      arrTargets,
      resolvedCleanup: cleanup,
      cleanupConfigured: downloadTargets.length > 0,
      attemptedArrInstanceIds: attemptedArrInstances.get(ratingKey),
    });
    return c.json(plan.preview satisfies VersionDeletionPreviewResponse);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not build deletion preview',
    }, 502);
  }
});

router.post('/episodes/:ratingKey/media/deletion-preview', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const mediaIds = parseMediaIds(await c.req.json().catch(() => null));
  if (!mediaIds) return c.json({ error: 'mediaIds must contain between 1 and 50 integers' }, 400);
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'episode not found' }, 404);

  const versions = await db.select().from(episodeMediaVersions)
    .where(episodeVersionsByEpisode(serverId, ratingKey));
  if (
    versions.length === 0 ||
    mediaIds.some((mediaId) => !versions.some((version) => version.mediaId === mediaId))
  ) return c.json({ error: 'one or more media versions were not found' }, 404);
  const target = versions[0]!;
  const [show] = await db.select({
    title: items.title,
    type: items.type,
    tmdbId: items.tmdbId,
    tvdbId: items.tvdbId,
  }).from(items).where(itemByRatingKey(serverId, target.showRatingKey)).limit(1);
  if (!show) return c.json({ error: 'show not found' }, 404);

  try {
    const client = await createPlexClient();
    const [liveVersions, arrTargets, downloadTargets] = await Promise.all([
      client.mediaVersionPathPreviews(ratingKey),
      getArrDeleteTargets(serverId, target.libraryKey),
      getDownloadClientTargets(serverId),
    ]);
    const plan = await buildVersionDeletionPlan({
      mediaType: 'episode',
      item: show,
      selectedMediaIds: new Set(mediaIds),
      liveVersions,
      arrTargets,
      resolvedCleanup: null,
      cleanupConfigured: downloadTargets.length > 0,
    });
    return c.json(plan.preview satisfies VersionDeletionPreviewResponse);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not build deletion preview',
    }, 502);
  }
});

// Batch counterpart to the single-version route below. External cleanup is planned
// against the complete selected set once, then each Plex Media entry is removed under
// the same library lease. This prevents a multi-select from deleting one title-wide
// Radarr/qBittorrent destination repeatedly or planning against state changed by the
// preceding version.
router.delete('/movies/:ratingKey/media', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const body = await c.req.json().catch(() => null) as {
    mediaIds?: unknown;
    deleteFromArr?: unknown;
    cleanupDownloads?: unknown;
  } | null;
  const mediaIds = parseMediaIds(body);
  if (!mediaIds) return c.json({ error: 'mediaIds must contain between 1 and 50 integers' }, 400);
  if (typeof body?.deleteFromArr !== 'boolean' || typeof body.cleanupDownloads !== 'boolean') {
    return c.json({ error: 'deleteFromArr and cleanupDownloads must be booleans' }, 400);
  }
  if (body.cleanupDownloads && !body.deleteFromArr) {
    return c.json({ error: 'qBittorrent cleanup requires verified Radarr deletion' }, 400);
  }

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'movie not found' }, 404);
  const [locator] = await db.select({ libraryKey: items.libraryKey }).from(items)
    .where(itemByRatingKey(serverId, ratingKey)).limit(1);
  if (!locator) return c.json({ error: 'movie not found' }, 404);
  const releaseLibrary = tryAcquireLibraryOperation(serverId, locator.libraryKey, 'deletion');
  if (!releaseLibrary) {
    return c.json({ error: 'this library is currently syncing or being modified' }, 409);
  }

  try {
    const [[item], versions] = await Promise.all([
      db.select({
        ratingKey: items.ratingKey,
        title: items.title,
        type: items.type,
        tmdbId: items.tmdbId,
        tvdbId: items.tvdbId,
        libraryKey: items.libraryKey,
      }).from(items).where(itemByRatingKey(serverId, ratingKey)).limit(1),
      db.select().from(itemMediaVersions).where(mediaVersionsByItem(serverId, ratingKey)),
    ]);
    if (!item || item.type !== 'movie') return c.json({ error: 'movie not found' }, 404);
    const selected = versions.filter((version) => mediaIds.includes(version.mediaId));
    if (selected.length !== mediaIds.length) {
      return c.json({ error: 'one or more media versions were not found' }, 404);
    }
    if (versions.length - selected.length < 1) {
      return c.json({ error: 'at least one version must remain; delete the movie instead' }, 400);
    }

    let client;
    try {
      client = await createPlexClient();
      const sessions = await client.activeSessions();
      if (mediaRatingKeyIsPlaying(ratingKey, sessions)) {
        return c.json({ error: 'cannot delete media versions during active playback' }, 409);
      }
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'could not verify active playback',
      }, 502);
    }

    const [liveVersions, arrTargets, downloadTargets, attemptedKeys, attemptedOrphans] =
      await Promise.all([
        client.mediaVersionPathPreviews(ratingKey),
        getArrDeleteTargets(serverId, item.libraryKey),
        getDownloadClientTargets(serverId),
        loadAttemptedDownloadJobKeysByItem(serverId, [ratingKey]),
        loadAttemptedOrphanFilesByItem(serverId, [ratingKey]),
      ]);
    const resolvedCleanup = await resolveDownloadCleanup(
      ratingKey,
      item,
      arrTargets,
      downloadTargets,
      attemptedKeys.get(ratingKey),
      attemptedOrphans.get(ratingKey),
    );
    const attemptedArrInstances = await loadAttemptedArrInstancesByItem(
      serverId,
      [item],
      arrTargets.map((target) => target.instanceId),
    );
    const plan = await buildVersionDeletionPlan({
      mediaType: 'movie',
      item,
      selectedMediaIds: new Set(mediaIds),
      liveVersions,
      arrTargets,
      resolvedCleanup,
      cleanupConfigured: downloadTargets.length > 0,
      attemptedArrInstanceIds: attemptedArrInstances.get(ratingKey),
    });
    if (body.deleteFromArr && plan.preview.arrStatus !== 'resolved') {
      return c.json({ error: plan.preview.arrReason ?? 'Radarr could not be verified' }, 409);
    }
    if (body.cleanupDownloads && !plan.cleanup) {
      return c.json({
        error: plan.preview.cleanupReason ?? 'qBittorrent cleanup could not be verified',
      }, 409);
    }

    const outcomes: DeletionStageOutcome[] = [];
    if (body.cleanupDownloads && plan.cleanup) {
      try {
        const cleanupResult = await executeDownloadedFileCleanup(
          plan.cleanup,
          new Set<string>(),
          new Set<string>(),
          async (job) => {
            await db.insert(torrentDeleteAttempts).values({
              serverId,
              ratingKey,
              instanceKey: job.instanceKey,
              torrentHash: job.jobId,
              startedAt: Math.floor(Date.now() / 1000),
            }).onConflictDoUpdate({
              target: [
                torrentDeleteAttempts.serverId,
                torrentDeleteAttempts.ratingKey,
                torrentDeleteAttempts.instanceKey,
                torrentDeleteAttempts.torrentHash,
              ],
              set: { startedAt: Math.floor(Date.now() / 1000) },
            });
          },
          undefined,
          async (orphanFile) => {
            const rootIdentity = await orphanRootIdentity(orphanFile.root);
            await db.insert(downloadFileDeleteAttempts).values({
              serverId,
              ratingKey,
              localPath: orphanFile.path,
              rootPath: orphanFile.root,
              rootDevice: rootIdentity.rootDevice,
              rootInode: rootIdentity.rootInode,
              startedAt: Math.floor(Date.now() / 1000),
            }).onConflictDoUpdate({
              target: [
                downloadFileDeleteAttempts.serverId,
                downloadFileDeleteAttempts.ratingKey,
                downloadFileDeleteAttempts.localPath,
              ],
              set: {
                rootPath: orphanFile.root,
                rootDevice: rootIdentity.rootDevice,
                rootInode: rootIdentity.rootInode,
                startedAt: Math.floor(Date.now() / 1000),
              },
            });
          },
        );
        appendCleanupOutcomes(outcomes, cleanupResult);
      } catch (error) {
        if (error instanceof DownloadedFileCleanupError) {
          appendCleanupOutcomes(outcomes, error.result);
          outcomes.push({
            system: error.system,
            target: error.target,
            status: 'failed',
            error: error.message,
          });
        }
        return c.json(
          {
            deletedMediaIds: [],
            failed: mediaIds.map((mediaId) => ({
              mediaId,
              error: error instanceof Error ? error.message : 'download cleanup failed',
            })),
            fileSizeFreed: 0,
            outcomes,
          } satisfies DeleteMediaVersionsResponse,
        );
      }
    }

    if (body.deleteFromArr) {
      let arrFailed = false;
      for (const entry of plan.eligibleArrTargets) {
        if (entry.alreadyAbsent) {
          outcomes.push({
            system: 'radarr',
            target: entry.target.instanceName,
            status: 'already-absent',
          });
          continue;
        }
        try {
          await db.insert(arrDeleteAttempts).values({
            serverId,
            ratingKey,
            libraryKey: item.libraryKey,
            arrInstanceId: entry.target.instanceId,
            externalId: item.tmdbId!,
            startedAt: Math.floor(Date.now() / 1000),
          }).onConflictDoUpdate({
            target: [
              arrDeleteAttempts.serverId,
              arrDeleteAttempts.ratingKey,
              arrDeleteAttempts.arrInstanceId,
            ],
            set: { startedAt: Math.floor(Date.now() / 1000) },
          });
          await entry.target.client.deleteMedia(
            entry.recordId!,
            entry.target.addImportExclusion,
          );
          outcomes.push({
            system: 'radarr',
            target: entry.target.instanceName,
            status: 'deleted',
          });
        } catch (error) {
          if (error instanceof ArrApiError && error.status === 404) {
            outcomes.push({
              system: 'radarr',
              target: entry.target.instanceName,
              status: 'already-absent',
            });
            continue;
          }
          arrFailed = true;
          outcomes.push({
            system: 'radarr',
            target: entry.target.instanceName,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Radarr deletion failed',
          });
        }
      }
      if (arrFailed) {
        return c.json(
          {
            deletedMediaIds: [],
            failed: mediaIds.map((mediaId) => ({
              mediaId,
              error: 'Radarr deletion did not complete in every verified instance',
            })),
            fileSizeFreed: 0,
            outcomes,
          } satisfies DeleteMediaVersionsResponse,
        );
      }
    }

    const deletedMediaIds: number[] = [];
    const failed: Array<{ mediaId: number; error: string }> = [];
    let fileSizeFreed = 0;
    const removals: Array<{
      serverId: number;
      operationId: string;
      targetKind: 'movie_version';
      targetKey: string;
      mediaSize: number | null;
    }> = [];
    const operationId = crypto.randomUUID();
    for (const target of selected) {
      const reserved = withTransaction((sqliteClient) =>
        sqliteClient.prepare(
          `DELETE FROM item_media_versions
           WHERE server_id = ? AND media_id = ?
             AND (SELECT COUNT(*) FROM item_media_versions
                  WHERE server_id = ? AND item_rating_key = ?) >= 2`,
        ).run(serverId, target.mediaId, serverId, ratingKey) > 0
      );
      if (!reserved) {
        failed.push({ mediaId: target.mediaId, error: 'last-version guard rejected deletion' });
        continue;
      }
      if (body.deleteFromArr) {
        deletedMediaIds.push(target.mediaId);
        fileSizeFreed += target.fileSize ?? 0;
        removals.push({
          serverId,
          operationId,
          targetKind: 'movie_version',
          targetKey: `${ratingKey}:${target.mediaId}`,
          mediaSize: target.fileSize,
        });
        continue;
      }
      try {
        const removedByApp = await deletePlexMediaTolerating404(
          client,
          ratingKey,
          target.mediaId,
        );
        deletedMediaIds.push(target.mediaId);
        fileSizeFreed += target.fileSize ?? 0;
        outcomes.push({
          system: 'plex',
          target: `${item.title} media ${target.mediaId}`,
          status: removedByApp ? 'deleted' : 'already-absent',
        });
        if (removedByApp) {
          removals.push({
            serverId,
            operationId,
            targetKind: 'movie_version',
            targetKey: `${ratingKey}:${target.mediaId}`,
            mediaSize: target.fileSize,
          });
        }
      } catch (error) {
        withTransaction((sqliteClient) => restoreItemMediaVersion(sqliteClient, target));
        failed.push({
          mediaId: target.mediaId,
          error: error instanceof Error ? error.message : 'Plex deletion failed',
        });
        outcomes.push({
          system: 'plex',
          target: `${item.title} media ${target.mediaId}`,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Plex deletion failed',
        });
      }
    }
    withTransaction((sqliteClient) => {
      sqliteClient.prepare(
        `UPDATE items SET file_size = (
           SELECT SUM(file_size) FROM item_media_versions
           WHERE server_id = ? AND item_rating_key = ?
         ) WHERE server_id = ? AND rating_key = ?`,
      ).run(serverId, ratingKey, serverId, ratingKey);
    });
    if (removals.length > 0) {
      await recordMediaRemovals(removals).catch((error) =>
        console.error('Failed to record removed media:', error)
      );
    }
    if (body.deleteFromArr && deletedMediaIds.length > 0) {
      await client.refreshLibrary(item.libraryKey).catch((error) => {
        console.warn(
          `Could not refresh Plex library ${item.libraryKey} after version deletion`,
          error,
        );
      });
    }
    await logEvents(deletedMediaIds.map((mediaId) => ({
      serverId,
      type: 'media.deleted' as const,
      payload: {
        libraryKey: item.libraryKey,
        ratingKey,
        title: item.title,
        mediaId,
        fileSizeFreed: selected.find((version) => version.mediaId === mediaId)?.fileSize ?? 0,
        outcomes,
      },
    })));
    return c.json(
      {
        deletedMediaIds,
        failed,
        fileSizeFreed,
        outcomes,
      } satisfies DeleteMediaVersionsResponse,
    );
  } finally {
    releaseLibrary();
  }
});

// Deletes a single Media version of a movie (one file) without touching its other
// versions or the item itself — distinct from DELETE /:key/items in routes/libraries.ts,
// which removes a whole item. Lives here rather than under /api/libraries because a
// media_id is already globally unique per server (the table's PK is
// (server_id, media_id)) — no library context is actually needed to address it, only
// to attribute the resulting activity-log entry, which is read back off the row itself.
router.delete('/movies/:ratingKey/media/:mediaId', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const mediaId = parseMediaId(c.req.param('mediaId'));
  if (mediaId === null) return c.json({ error: 'mediaId must be an integer' }, 400);

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'movie not found' }, 404);

  const [locator] = await db.select({ libraryKey: items.libraryKey }).from(items)
    .where(itemByRatingKey(serverId, ratingKey))
    .limit(1);
  if (!locator) return c.json({ error: 'movie not found' }, 404);
  const releaseLibrary = tryAcquireLibraryOperation(serverId, locator.libraryKey, 'deletion');
  if (!releaseLibrary) {
    return c.json({ error: 'this library is currently syncing or being modified' }, 409);
  }
  try {
    // Re-read under the library operation lease. The locator above only identifies
    // which lock to acquire and never authorizes a mutation by itself.
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

    let client;
    try {
      client = await createPlexClient();
      const sessions = await client.activeSessions();
      if (mediaRatingKeyIsPlaying(ratingKey, sessions)) {
        return c.json({ error: 'cannot delete a media version during active playback' }, 409);
      }
    } catch (err) {
      return c.json({
        error: err instanceof Error ? err.message : 'could not verify active playback',
      }, 502);
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

    let removedByApp: boolean;
    try {
      removedByApp = await deletePlexMediaTolerating404(client, ratingKey, mediaId);
    } catch (err) {
      // The reservation above already removed this version's local row — since Plex
      // never actually deleted the file (a real failure, not "already gone"), undo that
      // reservation rather than leave local state claiming a version is gone that's still
      // on disk.
      withTransaction((sqliteClient) => restoreItemMediaVersion(sqliteClient, target));
      return c.json({ error: err instanceof Error ? err.message : 'delete failed' }, 502);
    }

    // The reservation should still be absent, but repeat the delete after Plex commits.
    // This is cheap defense against any future writer that does not participate in the
    // library-operation lease.
    withTransaction((sqliteClient) => {
      sqliteClient.prepare(
        'DELETE FROM item_media_versions WHERE server_id = ? AND media_id = ?',
      ).run(serverId, mediaId);
    });

    const fileSizeFreed = target.fileSize ?? 0;
    if (removedByApp) {
      await recordMediaRemovals([{
        serverId,
        operationId: crypto.randomUUID(),
        targetKind: 'movie_version',
        targetKey: `${ratingKey}:${mediaId}`,
        mediaSize: target.fileSize,
      }]).catch((error) => console.error('Failed to record removed media:', error));
    }
    await logEvents([{
      serverId,
      type: 'media.deleted',
      payload: {
        libraryKey: item.libraryKey,
        ratingKey,
        title: item.title,
        mediaId,
        fileSizeFreed,
      },
    }]);

    return c.json({ fileSizeFreed } satisfies DeleteMediaVersionResponse);
  } finally {
    releaseLibrary();
  }
});

// Deletes a single Media version of an episode — the TV counterpart to
// DELETE /movies/:ratingKey/media/:mediaId above. Can't reuse that route: episodes are
// never `items` rows (TV syncs at show granularity, see CLAUDE.md), so ownership here
// is checked entirely against episode_media_versions instead of items.
router.delete('/episodes/:ratingKey/media/:mediaId', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const mediaId = parseMediaId(c.req.param('mediaId'));
  if (mediaId === null) return c.json({ error: 'mediaId must be an integer' }, 400);

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'episode not found' }, 404);

  const [locator] = await db.select({ libraryKey: episodeMediaVersions.libraryKey })
    .from(episodeMediaVersions)
    .where(episodeVersionsByEpisode(serverId, ratingKey))
    .limit(1);
  if (!locator) return c.json({ error: 'episode not found' }, 404);
  const releaseLibrary = tryAcquireLibraryOperation(serverId, locator.libraryKey, 'deletion');
  if (!releaseLibrary) {
    return c.json({ error: 'this library is currently syncing or being modified' }, 409);
  }
  try {
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

    let client;
    try {
      client = await createPlexClient();
      const sessions = await client.activeSessions();
      if (mediaRatingKeyIsPlaying(ratingKey, sessions)) {
        return c.json({ error: 'cannot delete a media version during active playback' }, 409);
      }
    } catch (err) {
      return c.json({
        error: err instanceof Error ? err.message : 'could not verify active playback',
      }, 502);
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

    let removedByApp: boolean;
    try {
      removedByApp = await deletePlexMediaTolerating404(client, ratingKey, mediaId);
    } catch (err) {
      withTransaction((sqliteClient) => restoreEpisodeMediaVersion(sqliteClient, target));
      return c.json({ error: err instanceof Error ? err.message : 'delete failed' }, 502);
    }

    withTransaction((sqliteClient) => {
      sqliteClient.prepare(
        'DELETE FROM episode_media_versions WHERE server_id = ? AND media_id = ?',
      ).run(serverId, mediaId);
    });

    const [show] = await db.select({ title: items.title }).from(items)
      .where(itemByRatingKey(serverId, target.showRatingKey)).limit(1);
    const title = `${
      show?.title ?? 'Unknown show'
    } — S${target.seasonIndex}E${target.episodeIndex} "${target.episodeTitle}"`;

    if (removedByApp) {
      await recordMediaRemovals([{
        serverId,
        operationId: crypto.randomUUID(),
        targetKind: 'episode_version',
        targetKey: `${ratingKey}:${mediaId}`,
        mediaSize: target.fileSize,
      }]).catch((error) => console.error('Failed to record removed media:', error));
    }

    await logEvents([{
      serverId,
      type: 'media.deleted',
      payload: { libraryKey: target.libraryKey, ratingKey, title, mediaId, fileSizeFreed: freed },
    }]);

    return c.json({ fileSizeFreed: freed } satisfies DeleteMediaVersionResponse);
  } finally {
    releaseLibrary();
  }
});

export default router;
