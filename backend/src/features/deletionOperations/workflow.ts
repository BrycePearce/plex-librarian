import { and, eq, inArray } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import {
  arrDeleteAttempts,
  downloadFileDeleteAttempts,
  items,
  torrentDeleteAttempts,
} from '../../db/schema.ts';
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
import { activeWholeItemRatingKeys } from '../mediaDeletion/activePlayback.ts';
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
import {
  assertAcceptedArrMappingsUnchanged,
  assertVersionIsNotPlaying,
  bestLiveReassignmentCandidate,
  directPlexDeletionStillSafe,
  persistArrOwnershipPlan,
  persistedArrOwnershipMap,
  persistedArrReassignmentMap,
  persistedRetainedMediaId,
  reconcileArrReassignmentFinalState,
  waitForArrManagedPath,
} from './arrReassignment.ts';
import { advancePhase, confirmReassignedRemoval } from './deletionState.ts';
import { reconcilePlexTarget } from './plexReconciliation.ts';
import {
  coordinateRadarrReassignment,
  tryRecoverRadarrWithoutSelectedProjection,
} from './radarrWorkflow.ts';
import {
  DeletionConvergenceError,
  type DeletionWorkTarget,
  PlexReconciliationError,
} from './types.ts';
import { type DurableTargetSnapshot, validateDeletionTarget } from './validation.ts';

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
  attemptParentRatingKey?: string,
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
          ratingKey: attemptParentRatingKey ?? ratingKey,
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
          ratingKey: attemptParentRatingKey ?? ratingKey,
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

async function ensureWholeItemDeleted(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  liveAtStart: Awaited<ReturnType<typeof validateDeletionTarget>>['live'],
): Promise<void> {
  if (!liveAtStart) {
    advancePhase(target, 'plex_reconciliation');
    await reconcilePlexTarget(target, snapshot);
    return;
  }
  const sessions = await client.activeSessions();
  if (activeWholeItemRatingKeys(new Set([snapshot.ratingKey]), sessions).size > 0) {
    throw new Error('cannot delete media with active playback');
  }
  if (snapshot.unmonitorFromArr) {
    advancePhase(target, 'arr_coordination');
    if (snapshot.type !== 'movie' || snapshot.tmdbId === null) {
      throw new Error('Radarr movie identity is required before unmonitoring');
    }
    const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
    let matched = false;
    for (const entry of arrTargets) {
      const record = await entry.client.lookup(snapshot.tmdbId);
      if (!record) continue;
      const monitorTarget = await entry.client.monitorTarget(record.id);
      if (!monitorTarget) continue;
      matched = true;
      await entry.client.setMonitorTarget(monitorTarget.id, false);
      const confirmed = await entry.client.lookup(snapshot.tmdbId);
      const confirmedTarget = confirmed ? await entry.client.monitorTarget(confirmed.id) : null;
      if (!confirmedTarget || confirmedTarget.monitored !== false) {
        throw new DeletionConvergenceError('Radarr did not retain the unmonitored state');
      }
    }
    if (!matched) throw new Error('No matching Radarr movie was found to unmonitor');
  }
  if (snapshot.mode === 'plex-only') {
    if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');
    advancePhase(target, 'plex_reconciliation');
    await reconcilePlexTarget(target, snapshot);
    return;
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

  if (
    snapshot.cleanupDownloads &&
    (target.phase === 'validating' || target.phase === 'download_cleanup')
  ) {
    if (target.phase === 'validating') advancePhase(target, 'download_cleanup');
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

  if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');

  const result = await deleteThroughArr(item, arrTargets, {
    attemptedInstanceIds: attemptedArr.get(snapshot.ratingKey),
    acceptAlreadyAbsent: false,
    onAttemptStarting: (entry) => markArrAttempt(target.serverId, snapshot, entry),
  });
  const disposition = arrDeleteDisposition(result);
  if (disposition.status !== 'complete') {
    throw new Error(
      result.failures.map((failure) => failure.error).join('; ') || 'Arr deletion failed',
    );
  }
  advancePhase(target, 'plex_reconciliation');
  await reconcilePlexTarget(target, snapshot);
}

async function ensureVersionDeleted(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  liveAtStart: Awaited<ReturnType<typeof validateDeletionTarget>>['live'],
): Promise<void> {
  const selectedIds = new Set(snapshot.selectedMediaIds ?? [snapshot.mediaId!]);
  const excludedReassignIds = new Set(snapshot.operationMediaIds ?? [...selectedIds]);
  let retainedMediaId = persistedRetainedMediaId(snapshot);
  if (!liveAtStart) {
    if (retainedMediaId !== null) {
      throw new Error('The retained Plex item disappeared during Arr reassignment');
    }
    const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
    assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, arrTargets);
    if (arrTargets.length > 0 || snapshot.arrOwnerships !== undefined) {
      if (snapshot.arrOwnerships === undefined) {
        throw new Error('The Plex source disappeared before Arr ownership was persisted');
      }
      const plan = await buildVersionDeletionPlan({
        mediaType: target.targetKind === 'movie_version' ? 'movie' : 'episode',
        item: snapshot,
        selectedMediaIds: selectedIds,
        liveVersions: [],
        arrTargets,
        resolvedCleanup: null,
        cleanupConfigured: false,
        excludedReassignMediaIds: excludedReassignIds,
        requiredMappingIdentities: snapshot.arrReassignmentMappings,
        requiredOwnerships: persistedArrOwnershipMap(snapshot),
        ...(snapshot.type === 'episode' &&
            snapshot.seasonIndex !== null && snapshot.seasonIndex !== undefined &&
            snapshot.episodeIndex !== null && snapshot.episodeIndex !== undefined
          ? {
            episodeIdentity: {
              seasonNumber: snapshot.seasonIndex,
              episodeNumber: snapshot.episodeIndex,
            },
          }
          : {}),
      });
      if (!plan.arrOwnershipValid) {
        throw new Error(plan.arrOwnershipReason ?? 'Arr ownership could not be verified');
      }
    }
    advancePhase(target, 'plex_reconciliation');
    await reconcilePlexTarget(target, snapshot);
    return;
  }
  const sourceVersionIsLive = liveAtStart.media.some((media) => media.mediaId === snapshot.mediaId);
  const liveIds = new Set(liveAtStart.media.map((media) => media.mediaId));
  if (
    snapshot.expectedRetainedVersion !== undefined &&
    !liveIds.has(snapshot.expectedRetainedVersion.mediaId)
  ) {
    throw new Error('the version selected to keep is no longer available in Plex');
  }
  const hasRemainingVersion = [...liveIds].some((id) => !excludedReassignIds.has(id));
  if (!sourceVersionIsLive && retainedMediaId === null) {
    const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
    assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, arrTargets);
    if (arrTargets.length === 0 && snapshot.arrOwnerships === undefined) {
      advancePhase(target, 'plex_reconciliation');
      await reconcilePlexTarget(target, snapshot);
      return;
    }
    if (snapshot.arrOwnerships === undefined) {
      throw new Error('The Plex source disappeared before Arr ownership was persisted');
    }
    const liveVersions = await client.mediaVersionPathPreviews(snapshot.ratingKey);
    const plan = await buildVersionDeletionPlan({
      mediaType: target.targetKind === 'movie_version' ? 'movie' : 'episode',
      item: snapshot,
      selectedMediaIds: selectedIds,
      liveVersions,
      arrTargets,
      resolvedCleanup: null,
      cleanupConfigured: false,
      excludedReassignMediaIds: excludedReassignIds,
      requiredMappingIdentities: snapshot.arrReassignmentMappings,
      requiredOwnerships: persistedArrOwnershipMap(snapshot),
      ...(snapshot.type === 'episode' &&
          snapshot.seasonIndex !== null && snapshot.seasonIndex !== undefined &&
          snapshot.episodeIndex !== null && snapshot.episodeIndex !== undefined
        ? {
          episodeIdentity: {
            seasonNumber: snapshot.seasonIndex,
            episodeNumber: snapshot.episodeIndex,
          },
        }
        : {}),
    });
    if (!plan.arrOwnershipValid) {
      throw new Error(plan.arrOwnershipReason ?? 'Arr ownership could not be verified');
    }
    advancePhase(target, 'plex_reconciliation');
    await reconcilePlexTarget(target, snapshot);
    return;
  }
  if (!hasRemainingVersion) {
    throw new Error('at least one unselected live Plex version must remain');
  }
  await assertVersionIsNotPlaying(client, snapshot.ratingKey);

  if (hasRemainingVersion && retainedMediaId === null) {
    const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
    assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, arrTargets);
    if (arrTargets.length > 0 || snapshot.arrOwnerships !== undefined) {
      const liveVersions = await client.mediaVersionPathPreviews(snapshot.ratingKey);
      const plan = await buildVersionDeletionPlan({
        mediaType: target.targetKind === 'movie_version' ? 'movie' : 'episode',
        item: snapshot,
        selectedMediaIds: selectedIds,
        liveVersions,
        arrTargets,
        resolvedCleanup: null,
        cleanupConfigured: false,
        excludedReassignMediaIds: excludedReassignIds,
        requiredMappingIdentities: snapshot.arrReassignmentMappings,
        requiredOwnerships: persistedArrOwnershipMap(snapshot),
        ...(snapshot.type === 'episode' &&
            snapshot.seasonIndex !== null && snapshot.seasonIndex !== undefined &&
            snapshot.episodeIndex !== null && snapshot.episodeIndex !== undefined
          ? {
            episodeIdentity: {
              seasonNumber: snapshot.seasonIndex,
              episodeNumber: snapshot.episodeIndex,
            },
          }
          : {}),
      });
      if (!plan.arrOwnershipValid) {
        throw new Error(
          plan.arrOwnershipReason ?? 'Arr ownership could not be verified',
        );
      }
      if (plan.arrManagedMediaIds.includes(snapshot.mediaId!)) {
        if (plan.preview.arrReassignStatus !== 'resolved') {
          throw new Error(
            plan.preview.arrReassignReason ??
              'The Arr-managed version cannot be safely reassigned',
          );
        }
        const candidateMediaId = bestLiveReassignmentCandidate(
          liveAtStart,
          plan.arrReassignCandidateMediaIds,
        );
        if (candidateMediaId === null) {
          throw new Error('No deterministic retained Arr version is available');
        }
        retainedMediaId = candidateMediaId;
      } else {
        persistArrOwnershipPlan(target.id, snapshot, plan);
      }
    }
  }

  if (snapshot.cleanupDownloads || retainedMediaId !== null) {
    if (snapshot.cleanupDownloads && target.phase === 'validating') {
      advancePhase(target, 'download_cleanup');
    }
    if (retainedMediaId !== null && target.phase !== 'arr_coordination') {
      advancePhase(target, 'arr_coordination');
    }
    const item: CoordinatedDeleteItem = snapshot;
    const attemptRatingKey = target.targetKind === 'episode_version'
      ? snapshot.showRatingKey!
      : snapshot.ratingKey;
    const [liveVersions, arrTargets, downloadTargets, attemptedJobs, attemptedOrphans] =
      await Promise.all([
        client.mediaVersionPathPreviews(snapshot.ratingKey),
        getArrDeleteTargets(target.serverId, snapshot.libraryKey),
        getDownloadClientTargets(target.serverId),
        loadAttemptedDownloadJobKeysByItem(target.serverId, [attemptRatingKey]),
        loadAttemptedOrphanFilesByItem(target.serverId, [attemptRatingKey]),
      ]);
    const resolvedCleanup = await resolveDownloadCleanup(
      snapshot.ratingKey,
      item,
      arrTargets,
      downloadTargets,
      attemptedJobs.get(attemptRatingKey),
      attemptedOrphans.get(attemptRatingKey),
    );
    const attemptedArr = await loadAttemptedArrInstancesByItem(
      target.serverId,
      [{ ...item, ratingKey: snapshot.ratingKey }],
      arrTargets.map((entry) => entry.instanceId),
    );
    let plan = await buildVersionDeletionPlan({
      mediaType: target.targetKind === 'movie_version' ? 'movie' : 'episode',
      item,
      selectedMediaIds: selectedIds,
      liveVersions,
      arrTargets,
      resolvedCleanup,
      cleanupConfigured: downloadTargets.length > 0,
      attemptedArrInstanceIds: attemptedArr.get(snapshot.ratingKey),
      excludedReassignMediaIds: excludedReassignIds,
      requiredMappingIdentities: snapshot.arrReassignmentMappings,
      requiredReassignments: persistedArrReassignmentMap(snapshot),
      requiredOwnerships: persistedArrOwnershipMap(snapshot),
      ...(snapshot.type === 'episode' &&
          snapshot.seasonIndex !== null && snapshot.seasonIndex !== undefined &&
          snapshot.episodeIndex !== null && snapshot.episodeIndex !== undefined
        ? {
          episodeIdentity: {
            seasonNumber: snapshot.seasonIndex,
            episodeNumber: snapshot.episodeIndex,
          },
        }
        : {}),
    });
    if (
      snapshot.cleanupDownloads &&
      (target.phase === 'validating' || target.phase === 'download_cleanup')
    ) {
      if (!plan.cleanup) {
        throw new Error(plan.preview.cleanupReason ?? 'cleanup could not be verified');
      }
      await assertVersionIsNotPlaying(client, snapshot.ratingKey);
      await executeCleanup(
        target.serverId,
        new Map([[snapshot.ratingKey, plan.cleanup]]),
        plan.cleanup,
        attemptRatingKey,
      );
      if (retainedMediaId !== null) {
        const [freshVersions, freshArrTargets] = await Promise.all([
          client.mediaVersionPathPreviews(snapshot.ratingKey),
          getArrDeleteTargets(target.serverId, snapshot.libraryKey),
        ]);
        plan = await buildVersionDeletionPlan({
          mediaType: target.targetKind === 'movie_version' ? 'movie' : 'episode',
          item,
          selectedMediaIds: selectedIds,
          liveVersions: freshVersions,
          arrTargets: freshArrTargets,
          resolvedCleanup: null,
          cleanupConfigured: false,
          excludedReassignMediaIds: excludedReassignIds,
          requiredMappingIdentities: snapshot.arrReassignmentMappings,
          requiredReassignments: persistedArrReassignmentMap(snapshot),
          requiredOwnerships: persistedArrOwnershipMap(snapshot),
          ...(snapshot.type === 'episode' &&
              snapshot.seasonIndex !== null && snapshot.seasonIndex !== undefined &&
              snapshot.episodeIndex !== null && snapshot.episodeIndex !== undefined
            ? {
              episodeIdentity: {
                seasonNumber: snapshot.seasonIndex,
                episodeNumber: snapshot.episodeIndex,
              },
            }
            : {}),
        });
      }
    }
    if (retainedMediaId !== null) {
      if (plan.preview.arrReassignStatus !== 'resolved') {
        throw new Error(
          plan.preview.arrReassignReason ?? 'Arr reassignment could not be verified',
        );
      }
      if (target.targetKind === 'movie_version') {
        await coordinateRadarrReassignment(
          target,
          snapshot,
          client,
          plan,
          retainedMediaId,
        );
      } else {
        await waitForArrManagedPath(
          target,
          plan,
          snapshot,
          client,
          retainedMediaId,
        );
        confirmReassignedRemoval(target);
        await reconcileArrReassignmentFinalState(target, snapshot, client);
        await reconcilePlexTarget(target, snapshot);
      }
      return;
    }
  }

  await assertVersionIsNotPlaying(client, snapshot.ratingKey);
  {
    const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
    assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, arrTargets);
    if (arrTargets.length > 0 || snapshot.arrOwnerships !== undefined) {
      const liveVersions = await client.mediaVersionPathPreviews(snapshot.ratingKey);
      const planInput = {
        mediaType: target.targetKind === 'movie_version' ? 'movie' as const : 'episode' as const,
        item: snapshot,
        selectedMediaIds: selectedIds,
        liveVersions,
        arrTargets,
        resolvedCleanup: null,
        cleanupConfigured: false,
        excludedReassignMediaIds: excludedReassignIds,
        requiredMappingIdentities: snapshot.arrReassignmentMappings,
        ...(snapshot.type === 'episode' &&
            snapshot.seasonIndex !== null && snapshot.seasonIndex !== undefined &&
            snapshot.episodeIndex !== null && snapshot.episodeIndex !== undefined
          ? {
            episodeIdentity: {
              seasonNumber: snapshot.seasonIndex,
              episodeNumber: snapshot.episodeIndex,
            },
          }
          : {}),
      };
      let finalPlan = await buildVersionDeletionPlan({
        ...planInput,
        requiredOwnerships: persistedArrOwnershipMap(snapshot),
      });
      if (!finalPlan.arrOwnershipValid) {
        const currentPlan = await buildVersionDeletionPlan(planInput);
        if (
          !currentPlan.arrOwnershipValid ||
          !currentPlan.arrManagedMediaIds.includes(snapshot.mediaId!) ||
          currentPlan.preview.arrReassignStatus !== 'resolved'
        ) {
          throw new Error(
            finalPlan.arrOwnershipReason ?? 'Arr ownership changed before Plex deletion',
          );
        }
        finalPlan = currentPlan;
      }
      if (finalPlan.arrManagedMediaIds.includes(snapshot.mediaId!)) {
        if (finalPlan.preview.arrReassignStatus !== 'resolved') {
          throw new Error(
            finalPlan.preview.arrReassignReason ??
              'The Arr-managed version cannot be safely reassigned',
          );
        }
        const validation = await validateDeletionTarget(target.serverId, target);
        if (!validation.live) {
          throw new Error('The retained Plex item disappeared during Arr reassignment');
        }
        const candidateMediaId = bestLiveReassignmentCandidate(
          validation.live,
          finalPlan.arrReassignCandidateMediaIds,
        );
        if (candidateMediaId === null) {
          throw new Error('No deterministic retained Arr version is available');
        }
        if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');
        if (target.targetKind === 'movie_version') {
          await coordinateRadarrReassignment(
            target,
            snapshot,
            client,
            finalPlan,
            candidateMediaId,
          );
        } else {
          await waitForArrManagedPath(
            target,
            finalPlan,
            snapshot,
            client,
            candidateMediaId,
          );
          confirmReassignedRemoval(target);
          await reconcileArrReassignmentFinalState(target, snapshot, client);
          await reconcilePlexTarget(target, snapshot);
        }
        return;
      }
    }
    if (!await directPlexDeletionStillSafe(target, snapshot, excludedReassignIds)) {
      throw new PlexReconciliationError(
        'at least one unselected live Plex version must remain',
        true,
        false,
      );
    }
  }
  if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');
  advancePhase(target, 'plex_reconciliation');
  await reconcilePlexTarget(target, snapshot);
}

export async function ensureDeletionTarget(target: DeletionWorkTarget): Promise<void> {
  const release = tryAcquireLibraryOperation(
    target.serverId,
    JSON.parse(target.snapshot).libraryKey,
    'deletion',
  );
  if (!release) throw new DeletionConvergenceError('the library is currently being modified');
  try {
    const snapshot = JSON.parse(target.snapshot) as DurableTargetSnapshot;
    if (target.phase === 'plex_reconciliation') {
      if ((snapshot.arrReassignments?.length ?? 0) > 0) {
        const validation = await validateDeletionTarget(target.serverId, target);
        await reconcileArrReassignmentFinalState(
          target,
          snapshot,
          validation.client,
        );
      }
      await reconcilePlexTarget(target, snapshot);
      return;
    }
    if (await tryRecoverRadarrWithoutSelectedProjection(target, snapshot)) return;
    const validation = await validateDeletionTarget(target.serverId, target);
    if (target.targetKind === 'whole_item') {
      await ensureWholeItemDeleted(
        target,
        validation.snapshot,
        validation.client,
        validation.live,
      );
    } else {
      await ensureVersionDeleted(target, validation.snapshot, validation.client, validation.live);
    }
  } finally {
    release();
  }
}
