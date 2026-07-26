import { bestMediaVersionCandidate } from '@plex-librarian/shared/mediaVersionRanking.ts';
import { withTransaction } from '../../db/index.ts';
import { ArrApiError } from '../../integrations/arr/client.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { mediaRatingKeyIsPlaying } from '../mediaDeletion/activePlayback.ts';
import {
  type PersistedArrOwnership,
  type PersistedArrReassignment,
} from '../mediaDeletion/arrReassignmentPlanning.ts';
import {
  buildVersionDeletionPlan,
  type VersionDeletionPlan,
} from '../mediaDeletion/versionPlanning.ts';
import { arrDirname } from '../mediaDeletion/arrPaths.ts';
import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';
import { DeletionConvergenceError, type DeletionWorkTarget } from './types.ts';
import { type DurableTargetSnapshot, validateDeletionTarget } from './validation.ts';

const ARR_CONVERGENCE_MAX_ATTEMPTS = 15;
const ARR_CONVERGENCE_POLL_INTERVAL_MS = 1_000;

export function persistedArrReassignmentMap(
  snapshot: DurableTargetSnapshot,
): Map<number, PersistedArrReassignment> {
  return new Map((snapshot.arrReassignments ?? []).map((entry) => [entry.instanceId, entry]));
}

export function persistedArrOwnershipMap(
  snapshot: DurableTargetSnapshot,
): Map<number, PersistedArrOwnership> {
  return new Map((snapshot.arrOwnerships ?? []).map((entry) => [entry.instanceId, entry]));
}

export function persistedRetainedMediaId(snapshot: DurableTargetSnapshot): number | null {
  const retained = new Set(
    (snapshot.arrReassignments ?? []).map((entry) => entry.retainedMediaId),
  );
  if (retained.size === 0) return null;
  if (retained.size !== 1) throw new Error('The persisted Arr reassignment target is inconsistent');
  return [...retained][0]!;
}

function currentArrMappingIdentities(
  targetKind: DeletionWorkTarget['targetKind'],
  arrTargets: readonly ArrDeleteTarget[],
) {
  const expectedType = targetKind === 'movie_version' ? 'radarr' : 'sonarr';
  return arrTargets.filter((target) => target.instanceType === expectedType).map((target) => ({
    instanceId: target.instanceId,
    instanceType: target.instanceType,
    instanceUrl: target.instanceUrl,
    configurationUpdatedAt: target.configurationUpdatedAt,
    mappingIdentity: target.mappingIdentity,
  })).sort((left, right) => left.instanceId - right.instanceId);
}

export function assertAcceptedArrMappingsUnchanged(
  targetKind: DeletionWorkTarget['targetKind'],
  snapshot: DurableTargetSnapshot,
  arrTargets: readonly ArrDeleteTarget[],
): void {
  if (snapshot.arrReassignmentMappings === undefined) return;
  if (
    JSON.stringify(currentArrMappingIdentities(targetKind, arrTargets)) !==
      JSON.stringify(snapshot.arrReassignmentMappings)
  ) {
    throw new Error('The mapped Arr instance set changed after deletion was accepted');
  }
}

export async function assertVersionIsNotPlaying(
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  ratingKey: string,
): Promise<void> {
  if (mediaRatingKeyIsPlaying(ratingKey, await client.activeSessions())) {
    throw new Error('cannot delete a media version during active playback');
  }
}

export async function directPlexDeletionStillSafe(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  excludedMediaIds: ReadonlySet<number>,
): Promise<boolean> {
  const validation = await validateDeletionTarget(target.serverId, target);
  if (!validation.live) return false;
  const liveMediaIds = new Set(validation.live.media.map((version) => version.mediaId));
  if (!liveMediaIds.has(snapshot.mediaId!)) return false;
  if (![...liveMediaIds].some((mediaId) => !excludedMediaIds.has(mediaId))) {
    throw new Error('at least one unselected live Plex version must remain');
  }
  await assertVersionIsNotPlaying(validation.client, snapshot.ratingKey);
  return true;
}

function persistArrReassignmentPlan(
  targetId: number,
  snapshot: DurableTargetSnapshot,
  plan: VersionDeletionPlan,
  retainMediaId: number,
): void {
  if ((snapshot.arrReassignments?.length ?? 0) > 0) return;
  const arrReassignments = plan.eligibleArrReassignments.map((entry) => {
    const retainedPath = entry.candidatePaths.get(retainMediaId);
    const retainedRecordPath = entry.candidateRecordPaths.get(retainMediaId);
    if (
      retainedPath === undefined || retainedRecordPath === undefined ||
      entry.managedFileId === null ||
      entry.managedMediaId !== snapshot.mediaId || entry.managedPath === null ||
      !entry.target.instanceUrl || !Number.isInteger(entry.target.configurationUpdatedAt) ||
      !entry.target.mappingIdentity
    ) {
      throw new Error('The Arr reassignment identity is incomplete');
    }
    return {
      instanceId: entry.target.instanceId,
      instanceType: entry.target.instanceType,
      instanceUrl: entry.target.instanceUrl,
      configurationUpdatedAt: entry.target.configurationUpdatedAt,
      mappingIdentity: entry.target.mappingIdentity,
      recordId: entry.recordId,
      recordPath: entry.recordPath,
      episodeId: entry.episodeId,
      managedFileId: entry.managedFileId,
      managedPath: entry.managedPath,
      retainedMediaId: retainMediaId,
      retainedPath,
      retainedRecordPath,
      retainedFileSize: entry.candidateFileSizes.get(retainMediaId) ?? null,
    } satisfies PersistedArrReassignment;
  }).sort((left, right) => left.instanceId - right.instanceId);
  const persistedSnapshot = {
    ...snapshot,
    arrReassignmentMappings: plan.arrMappingIdentities,
    arrOwnerships: plan.arrOwnerships,
    arrReassignments,
  };
  const updated = withTransaction((client) =>
    client.prepare(
      "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running'",
    ).run(JSON.stringify(persistedSnapshot), Math.floor(Date.now() / 1000), targetId)
  );
  if (updated !== 1) throw new DeletionConvergenceError('Could not persist Arr reassignment plan');
  snapshot.arrReassignments = arrReassignments;
  snapshot.arrReassignmentMappings = plan.arrMappingIdentities;
  snapshot.arrOwnerships = plan.arrOwnerships;
}

export function persistArrOwnershipPlan(
  targetId: number,
  snapshot: DurableTargetSnapshot,
  plan: VersionDeletionPlan,
): void {
  if (snapshot.arrOwnerships !== undefined) return;
  const persistedSnapshot = {
    ...snapshot,
    arrReassignmentMappings: plan.arrMappingIdentities,
    arrOwnerships: plan.arrOwnerships,
    arrReassignments: [],
  };
  const updated = withTransaction((client) =>
    client.prepare(
      "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running'",
    ).run(JSON.stringify(persistedSnapshot), Math.floor(Date.now() / 1000), targetId)
  );
  if (updated !== 1) throw new DeletionConvergenceError('Could not persist Arr ownership plan');
  snapshot.arrReassignmentMappings = plan.arrMappingIdentities;
  snapshot.arrOwnerships = plan.arrOwnerships;
  snapshot.arrReassignments = [];
}

export function bestLiveReassignmentCandidate(
  live: NonNullable<Awaited<ReturnType<typeof validateDeletionTarget>>['live']>,
  candidateMediaIds: readonly number[],
): number | null {
  const liveIds = new Set(live.media.map((version) => version.mediaId));
  if (candidateMediaIds.some((mediaId) => !liveIds.has(mediaId))) return null;
  return bestMediaVersionCandidate(live.media, candidateMediaIds);
}

function sameRemotePath(left: string | null, right: string): boolean {
  const normalizedLeft = left ? normalizeRemoteAbsolute(left)?.comparison : null;
  const normalizedRight = normalizeRemoteAbsolute(right)?.comparison;
  return normalizedLeft !== null && normalizedLeft !== undefined &&
    normalizedLeft === normalizedRight;
}

async function revalidateArrReassignment(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  instanceId: number,
): Promise<VersionDeletionPlan['eligibleArrReassignments'][number]> {
  const selectedIds = new Set(snapshot.selectedMediaIds ?? [snapshot.mediaId!]);
  const excludedIds = new Set(snapshot.operationMediaIds ?? [...selectedIds]);
  const retainedMediaId = persistedRetainedMediaId(snapshot);
  if (retainedMediaId === null) throw new Error('The Arr reassignment plan is incomplete');
  const [liveVersions, arrTargets] = await Promise.all([
    client.mediaVersionPathPreviews(snapshot.ratingKey),
    getArrDeleteTargets(target.serverId, snapshot.libraryKey),
  ]);
  const plan = await buildVersionDeletionPlan({
    mediaType: target.targetKind === 'movie_version' ? 'movie' : 'episode',
    item: snapshot,
    selectedMediaIds: selectedIds,
    liveVersions,
    arrTargets,
    resolvedCleanup: null,
    cleanupConfigured: false,
    excludedReassignMediaIds: excludedIds,
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
  if (plan.preview.arrReassignStatus !== 'resolved') {
    throw new Error(plan.preview.arrReassignReason ?? 'Arr reassignment could not be verified');
  }

  const validation = await validateDeletionTarget(target.serverId, target);
  const live = validation.live;
  if (!live) throw new Error('The retained Plex item disappeared during Arr reassignment');
  const liveIds = new Set(live.media.map((version) => version.mediaId));
  if (![...liveIds].some((id) => !excludedIds.has(id))) {
    throw new Error('at least one unselected live Plex version must remain');
  }
  if (!liveIds.has(retainedMediaId)) {
    throw new Error('The retained Plex version disappeared during Arr reassignment');
  }
  const bestCandidate = bestLiveReassignmentCandidate(
    live,
    plan.arrReassignCandidateMediaIds,
  );
  if (bestCandidate !== retainedMediaId) {
    throw new Error('The persisted retained version is no longer the best available copy');
  }
  if (mediaRatingKeyIsPlaying(snapshot.ratingKey, await validation.client.activeSessions())) {
    throw new Error('cannot delete a media version during active playback');
  }
  const entry = plan.eligibleArrReassignments.find((candidate) =>
    candidate.target.instanceId === instanceId
  );
  if (!entry) throw new Error('A required Arr reassignment instance could not be verified');
  return entry;
}

export async function waitForArrManagedPath(
  target: DeletionWorkTarget,
  plan: VersionDeletionPlan,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  retainMediaId: number,
): Promise<void> {
  persistArrReassignmentPlan(target.id, snapshot, plan, retainMediaId);
  for (const persisted of snapshot.arrReassignments!) {
    let entry = await revalidateArrReassignment(
      target,
      snapshot,
      client,
      persisted.instanceId,
    );
    const desiredPath = persisted.retainedPath;
    const desiredRecordPath = persisted.retainedRecordPath ??
      (persisted.instanceType === 'radarr'
        ? arrDirname(persisted.retainedPath)
        : persisted.recordPath);
    if (!desiredRecordPath) {
      throw new Error('The persisted Radarr destination path is incomplete');
    }
    if (!entry.alreadyReassigned && entry.managedFileId !== null) {
      try {
        await entry.target.client.deleteManagedFile(entry.managedFileId);
      } catch (error) {
        if (!(error instanceof ArrApiError) || error.status !== 404) throw error;
      }
    }
    entry = await revalidateArrReassignment(target, snapshot, client, persisted.instanceId);
    if (
      persisted.instanceType === 'radarr' &&
      !sameRemotePath(entry.recordPath, desiredRecordPath)
    ) {
      await entry.target.client.updateMoviePath(
        entry.recordId,
        persisted.recordPath,
        desiredRecordPath,
      );
      entry = await revalidateArrReassignment(target, snapshot, client, persisted.instanceId);
      if (!sameRemotePath(entry.recordPath, desiredRecordPath)) {
        throw new DeletionConvergenceError(
          `${entry.target.instanceName} did not retain the updated movie path`,
        );
      }
    }
    await entry.target.client.rescanMedia(entry.recordId);

    let converged = false;
    for (let attempt = 0; attempt < ARR_CONVERGENCE_MAX_ATTEMPTS; attempt++) {
      entry = await revalidateArrReassignment(target, snapshot, client, persisted.instanceId);
      if (sameRemotePath(entry.managedPath, desiredPath)) {
        if (entry.managedFileId === null || entry.managedFileId === persisted.managedFileId) {
          throw new Error(
            `${entry.target.instanceName} did not create a new managed-file record`,
          );
        }
        if (
          persisted.retainedFileSize !== undefined &&
          persisted.retainedFileSize !== null &&
          entry.managedFileSize !== persisted.retainedFileSize
        ) {
          throw new Error(
            `${entry.target.instanceName} reported unexpected metadata for the retained file`,
          );
        }
        converged = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, ARR_CONVERGENCE_POLL_INTERVAL_MS));
    }
    if (!converged) {
      throw new DeletionConvergenceError(
        `${entry.target.instanceName} did not adopt the retained Plex version`,
      );
    }
  }
}
