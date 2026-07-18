import { and, eq, inArray } from 'drizzle-orm';
import { db, type SqliteClient, withTransaction } from '../../db/index.ts';
import {
  arrDeleteAttempts,
  downloadFileDeleteAttempts,
  items,
  torrentDeleteAttempts,
} from '../../db/schema.ts';
import { ArrApiError } from '../../integrations/arr/client.ts';
import { PlexDeleteError } from '../../integrations/plex/client.ts';
import { tryAcquireLibraryOperation } from '../../services/libraryOperations.ts';
import {
  arrDeleteDisposition,
  type ArrDeleteTarget,
  assertArrDeleteIsUnambiguous,
  type CoordinatedDeleteItem,
  deleteThroughArr,
  findAmbiguousExternalIds,
  getArrDeleteTargets,
} from '../arr/delete.ts';
import {
  activeWholeItemRatingKeys,
  mediaRatingKeyIsPlaying,
} from '../mediaDeletion/activePlayback.ts';
import {
  executeDownloadedFileCleanup,
  reconcileSharedDownloadCleanups,
  type ResolvedCleanupItem,
  resolveDownloadCleanup,
  selectVerifiedDownloadCleanups,
} from '../mediaDeletion/cleanup.ts';
import { orphanRootIdentity } from '../mediaDeletion/hardlinks.ts';
import {
  loadAttemptedArrInstancesByItem,
  loadAttemptedDownloadJobKeysByItem,
  loadAttemptedOrphanFilesByItem,
  resolveDownloadCleanupBatch,
} from '../mediaDeletion/planning.ts';
import { getDownloadClientTargets } from '../mediaDeletion/targets.ts';
import { buildVersionDeletionPlan } from '../mediaDeletion/versionPlanning.ts';
import { type DurableTargetSnapshot, validateDeletionTarget } from './validation.ts';
import { refreshDeletionOperation } from './state.ts';

export interface DeletionWorkTarget {
  id: number;
  operationId: string;
  serverId: number;
  targetKind: 'whole_item' | 'movie_version' | 'episode_version';
  targetKey: string;
  snapshot: string;
  logicalSize: number | null;
}

export class DeletionConvergenceError extends Error {}

function externalId(item: CoordinatedDeleteItem): number | null {
  return item.type === 'movie' ? item.tmdbId : item.type === 'show' ? item.tvdbId : null;
}

async function markArrAttempt(
  serverId: number,
  snapshot: DurableTargetSnapshot,
  target: ArrDeleteTarget,
): Promise<void> {
  await db.insert(arrDeleteAttempts).values({
    serverId,
    ratingKey: snapshot.ratingKey,
    libraryKey: snapshot.libraryKey,
    arrInstanceId: target.instanceId,
    externalId: externalId(snapshot)!,
    startedAt: Math.floor(Date.now() / 1000),
  }).onConflictDoUpdate({
    target: [
      arrDeleteAttempts.serverId,
      arrDeleteAttempts.ratingKey,
      arrDeleteAttempts.arrInstanceId,
    ],
    set: {
      libraryKey: snapshot.libraryKey,
      externalId: externalId(snapshot)!,
      startedAt: Math.floor(Date.now() / 1000),
    },
  });
}

async function executeCleanup(
  serverId: number,
  associations: ReadonlyMap<string, ResolvedCleanupItem>,
  cleanup: ResolvedCleanupItem,
): Promise<void> {
  await executeDownloadedFileCleanup(
    cleanup,
    new Set(),
    new Set(),
    async (job) => {
      const jobKey = `${job.instanceKey}:${job.jobId}`;
      for (const [ratingKey, associated] of associations) {
        if (
          !associated.downloadJobs.some((candidate) =>
            `${candidate.instanceKey}:${candidate.jobId}` === jobKey
          )
        ) continue;
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
      }
    },
    undefined,
    async (file) => {
      const root = await orphanRootIdentity(file.root);
      for (const [ratingKey, associated] of associations) {
        if (!associated.orphanFiles.some((candidate) => candidate.path === file.path)) continue;
        await db.insert(downloadFileDeleteAttempts).values({
          serverId,
          ratingKey,
          localPath: file.path,
          rootPath: file.root,
          rootDevice: root.rootDevice,
          rootInode: root.rootInode,
          startedAt: Math.floor(Date.now() / 1000),
        }).onConflictDoUpdate({
          target: [
            downloadFileDeleteAttempts.serverId,
            downloadFileDeleteAttempts.ratingKey,
            downloadFileDeleteAttempts.localPath,
          ],
          set: {
            rootPath: file.root,
            rootDevice: root.rootDevice,
            rootInode: root.rootInode,
            startedAt: Math.floor(Date.now() / 1000),
          },
        });
      }
    },
  );
}

function finalizeTarget(
  client: SqliteClient,
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  attributable: boolean,
): void {
  let removed = 0;
  if (target.targetKind === 'whole_item') {
    removed = client.prepare('DELETE FROM items WHERE server_id = ? AND rating_key = ?').run(
      target.serverId,
      snapshot.ratingKey,
    );
  } else if (target.targetKind === 'movie_version') {
    removed = client.prepare(
      'DELETE FROM item_media_versions WHERE server_id = ? AND item_rating_key = ? AND media_id = ?',
    ).run(target.serverId, snapshot.ratingKey, snapshot.mediaId!);
    client.prepare(
      'UPDATE items SET file_size = (SELECT SUM(file_size) FROM item_media_versions WHERE server_id = ? AND item_rating_key = ?) WHERE server_id = ? AND rating_key = ?',
    ).run(target.serverId, snapshot.ratingKey, target.serverId, snapshot.ratingKey);
  } else {
    removed = client.prepare(
      'DELETE FROM episode_media_versions WHERE server_id = ? AND episode_rating_key = ? AND media_id = ?',
    ).run(target.serverId, snapshot.ratingKey, snapshot.mediaId!);
    if (removed > 0) {
      const size = snapshot.fileSize ?? 0;
      client.prepare(
        'UPDATE seasons SET file_size = MAX(0, COALESCE(file_size, 0) - ?) WHERE server_id = ? AND rating_key = ?',
      ).run(size, target.serverId, snapshot.seasonRatingKey!);
      client.prepare(
        "UPDATE items SET file_size = MAX(0, COALESCE(file_size, 0) - ?) WHERE server_id = ? AND rating_key = ? AND type = 'show'",
      ).run(size, target.serverId, snapshot.showRatingKey!);
    }
  }
  if (removed > 0 && attributable) {
    const kind = target.targetKind === 'whole_item' ? 'item' : target.targetKind;
    client.prepare(
      'INSERT OR IGNORE INTO media_removals (server_id, operation_id, target_kind, target_key, media_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      target.serverId,
      target.operationId,
      kind,
      target.targetKey,
      target.logicalSize,
      Math.floor(Date.now() / 1000),
    );
  }
  client.prepare('DELETE FROM media_version_reservations WHERE target_id = ?').run(target.id);
  client.prepare(
    "UPDATE deletion_targets SET status = 'completed', next_retry_at = NULL, error = NULL, updated_at = ? WHERE id = ? AND status = 'running'",
  ).run(Math.floor(Date.now() / 1000), target.id);
}

async function ensureWholeItemDeleted(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  liveAtStart: Awaited<ReturnType<typeof validateDeletionTarget>>['live'],
): Promise<boolean> {
  if (!liveAtStart) return false;
  const sessions = await client.activeSessions();
  if (activeWholeItemRatingKeys(new Set([snapshot.ratingKey]), sessions).size > 0) {
    throw new Error('cannot delete media with active playback');
  }
  if (snapshot.mode === 'plex-only') {
    let removedByApp = true;
    try {
      await client.deleteItem(snapshot.ratingKey);
    } catch (error) {
      if (!(error instanceof PlexDeleteError) || error.status !== 404) throw error;
      removedByApp = false;
    }
    if (await client.metadataIdentity(snapshot.ratingKey)) {
      throw new DeletionConvergenceError('Plex still reports the item after deletion');
    }
    return removedByApp;
  }

  const item: CoordinatedDeleteItem = snapshot;
  const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
  if (arrTargets.length === 0) throw new Error('this library is not mapped to Sonarr or Radarr');
  const id = externalId(item);
  if (id === null) throw new Error('the target has no Arr external ID');
  const ambiguous = withTransaction((sqlite) =>
    findAmbiguousExternalIds(
      sqlite,
      target.serverId,
      item.type === 'movie' ? 'movie' : 'show',
      [id],
    )
  );
  assertArrDeleteIsUnambiguous(item, ambiguous);
  const attemptedArr = await loadAttemptedArrInstancesByItem(
    target.serverId,
    [{ ...item, ratingKey: snapshot.ratingKey }],
    arrTargets.map((entry) => entry.instanceId),
  );

  if (snapshot.cleanupDownloads) {
    const selectedKeys = snapshot.selectedRatingKeys ?? [snapshot.ratingKey];
    const selected = await db.select({
      ratingKey: items.ratingKey,
      title: items.title,
      type: items.type,
      tmdbId: items.tmdbId,
      tvdbId: items.tvdbId,
    }).from(items).where(and(
      eq(items.serverId, target.serverId),
      inArray(items.ratingKey, selectedKeys),
    ));
    const downloadTargets = await getDownloadClientTargets(target.serverId);
    const attemptedJobs = await loadAttemptedDownloadJobKeysByItem(target.serverId, selectedKeys);
    const attemptedOrphans = await loadAttemptedOrphanFilesByItem(target.serverId, selectedKeys);
    const attemptedByItem = await loadAttemptedArrInstancesByItem(
      target.serverId,
      selected,
      arrTargets.map((entry) => entry.instanceId),
    );
    const cleanups = selectVerifiedDownloadCleanups(reconcileSharedDownloadCleanups(
      await resolveDownloadCleanupBatch(
        selected,
        arrTargets,
        downloadTargets,
        attemptedJobs,
        attemptedOrphans,
        attemptedByItem,
      ),
    ));
    const cleanup = cleanups.get(snapshot.ratingKey);
    if (!cleanup) throw new Error('no verified downloaded-file cleanup is available');
    await executeCleanup(target.serverId, cleanups, cleanup);
  }

  const result = await deleteThroughArr(item, arrTargets, {
    attemptedInstanceIds: attemptedArr.get(snapshot.ratingKey),
    acceptAlreadyAbsent: true,
    onAttemptStarting: (entry) => markArrAttempt(target.serverId, snapshot, entry),
  });
  const disposition = arrDeleteDisposition(result);
  if (disposition.status !== 'complete') {
    throw new Error(
      result.failures.map((failure) => failure.error).join('; ') || 'Arr deletion failed',
    );
  }
  await client.refreshLibrary(snapshot.libraryKey);
  if (await client.metadataIdentity(snapshot.ratingKey)) {
    throw new DeletionConvergenceError('Plex has not converged after the Arr deletion');
  }
  return result.deletedInstances.some((entry) => !entry.alreadyAbsent);
}

async function ensureVersionDeleted(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  liveAtStart: Awaited<ReturnType<typeof validateDeletionTarget>>['live'],
): Promise<boolean> {
  const selectedIds = new Set(snapshot.selectedMediaIds ?? [snapshot.mediaId!]);
  if (!liveAtStart || !liveAtStart.media.some((media) => media.mediaId === snapshot.mediaId)) {
    return false;
  }
  const liveIds = new Set(liveAtStart.media.map((media) => media.mediaId));
  if (![...liveIds].some((id) => !selectedIds.has(id))) {
    throw new Error('at least one unselected live Plex version must remain');
  }
  if (mediaRatingKeyIsPlaying(snapshot.ratingKey, await client.activeSessions())) {
    throw new Error('cannot delete a media version during active playback');
  }

  if (snapshot.deleteFromArr || snapshot.cleanupDownloads) {
    const item: CoordinatedDeleteItem = snapshot;
    const [liveVersions, arrTargets, downloadTargets, attemptedJobs, attemptedOrphans] =
      await Promise.all([
        client.mediaVersionPathPreviews(snapshot.ratingKey),
        getArrDeleteTargets(target.serverId, snapshot.libraryKey),
        getDownloadClientTargets(target.serverId),
        loadAttemptedDownloadJobKeysByItem(target.serverId, [snapshot.ratingKey]),
        loadAttemptedOrphanFilesByItem(target.serverId, [snapshot.ratingKey]),
      ]);
    const resolvedCleanup = await resolveDownloadCleanup(
      snapshot.ratingKey,
      item,
      arrTargets,
      downloadTargets,
      attemptedJobs.get(snapshot.ratingKey),
      attemptedOrphans.get(snapshot.ratingKey),
    );
    const attemptedArr = await loadAttemptedArrInstancesByItem(
      target.serverId,
      [{ ...item, ratingKey: snapshot.ratingKey }],
      arrTargets.map((entry) => entry.instanceId),
    );
    const plan = await buildVersionDeletionPlan({
      mediaType: target.targetKind === 'movie_version' ? 'movie' : 'episode',
      item,
      selectedMediaIds: selectedIds,
      liveVersions,
      arrTargets,
      resolvedCleanup,
      cleanupConfigured: downloadTargets.length > 0,
      attemptedArrInstanceIds: attemptedArr.get(snapshot.ratingKey),
    });
    if (snapshot.cleanupDownloads) {
      if (!plan.cleanup) {
        throw new Error(plan.preview.cleanupReason ?? 'cleanup could not be verified');
      }
      await executeCleanup(
        target.serverId,
        new Map([[snapshot.ratingKey, plan.cleanup]]),
        plan.cleanup,
      );
    }
    if (snapshot.deleteFromArr) {
      if (plan.preview.arrStatus !== 'resolved') {
        const id = externalId(item);
        if (id === null) throw new Error('the target has no Radarr external ID');
        const records = await Promise.all(arrTargets.map((entry) => entry.client.lookup(id)));
        if (records.some((record) => record !== null)) {
          throw new Error(plan.preview.arrReason ?? 'Radarr deletion could not be verified');
        }
        await client.refreshLibrary(snapshot.libraryKey);
        const after = await client.metadataIdentity(snapshot.ratingKey);
        if (after?.media.some((media) => media.mediaId === snapshot.mediaId)) {
          throw new DeletionConvergenceError('Plex has not converged after Radarr was absent');
        }
        return false;
      }
      let madeAttempt = false;
      for (const entry of plan.eligibleArrTargets) {
        if (entry.alreadyAbsent) continue;
        await markArrAttempt(target.serverId, snapshot, entry.target);
        try {
          await entry.target.client.deleteMedia(entry.recordId!, entry.target.addImportExclusion);
          madeAttempt = true;
        } catch (error) {
          if (!(error instanceof ArrApiError) || error.status !== 404) throw error;
        }
      }
      await client.refreshLibrary(snapshot.libraryKey);
      const after = await client.metadataIdentity(snapshot.ratingKey);
      if (after?.media.some((media) => media.mediaId === snapshot.mediaId)) {
        throw new DeletionConvergenceError('Plex has not converged after the Radarr deletion');
      }
      return madeAttempt;
    }
  }

  let removedByApp = true;
  try {
    await client.deleteMedia(snapshot.ratingKey, snapshot.mediaId!);
  } catch (error) {
    if (!(error instanceof PlexDeleteError) || error.status !== 404) throw error;
    removedByApp = false;
  }
  const after = await client.metadataIdentity(snapshot.ratingKey);
  if (after?.media.some((media) => media.mediaId === snapshot.mediaId)) {
    throw new DeletionConvergenceError('Plex still reports the media version after deletion');
  }
  return removedByApp;
}

export async function ensureDeletionTarget(target: DeletionWorkTarget): Promise<void> {
  const release = tryAcquireLibraryOperation(
    target.serverId,
    JSON.parse(target.snapshot).libraryKey,
    'deletion',
  );
  if (!release) throw new DeletionConvergenceError('the library is currently being modified');
  try {
    const validation = await validateDeletionTarget(target.serverId, target);
    const attributable = target.targetKind === 'whole_item'
      ? await ensureWholeItemDeleted(
        target,
        validation.snapshot,
        validation.client,
        validation.live,
      )
      : await ensureVersionDeleted(target, validation.snapshot, validation.client, validation.live);
    withTransaction((client) => {
      finalizeTarget(client, target, validation.snapshot, attributable);
      refreshDeletionOperation(client, target.operationId);
    });
  } finally {
    release();
  }
}
