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
import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';
import { radarrBytesMatchProjectedKilobytes } from '../mediaDeletion/radarrSize.ts';
import {
  ArrMonitoringReconciliationError,
  DeletionConvergenceError,
  type DeletionWorkTarget,
  PlexReconciliationError,
} from './types.ts';
import {
  type DurableTargetSnapshot,
  validateDeletionTarget,
  validateLiveDeletionIdentity,
} from './validation.ts';

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
  if (snapshot.radarrRemovalFallback) return snapshot.radarrRemovalFallback.retainedMediaId;
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
  if (
    snapshot.expectedRetainedVersion !== undefined &&
    !liveMediaIds.has(snapshot.expectedRetainedVersion.mediaId)
  ) {
    throw new Error('the version selected to keep is no longer available in Plex');
  }
  if (![...liveMediaIds].some((mediaId) => !excludedMediaIds.has(mediaId))) {
    throw new Error('at least one unselected live Plex version must remain');
  }
  await assertVersionIsNotPlaying(validation.client, snapshot.ratingKey);
  return true;
}

export function persistArrReassignmentPlan(
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
      originalMonitored: entry.monitored,
      ...(entry.radarrPathPlan ? { radarrPathPlan: entry.radarrPathPlan } : {}),
    } satisfies PersistedArrReassignment;
  }).sort((left, right) => left.instanceId - right.instanceId);
  const persistedSnapshot = {
    ...snapshot,
    arrReassignmentMappings: plan.arrMappingIdentities,
    arrOwnerships: plan.arrOwnerships,
    arrReassignments,
  };
  const expectedSnapshot = JSON.stringify(snapshot);
  const updated = withTransaction((client) =>
    client.prepare(
      "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running' AND snapshot = ?",
    ).run(
      JSON.stringify(persistedSnapshot),
      Math.floor(Date.now() / 1000),
      targetId,
      expectedSnapshot,
    )
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
  const expectedSnapshot = JSON.stringify(snapshot);
  const updated = withTransaction((client) =>
    client.prepare(
      "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running' AND snapshot = ?",
    ).run(
      JSON.stringify(persistedSnapshot),
      Math.floor(Date.now() / 1000),
      targetId,
      expectedSnapshot,
    )
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

export async function revalidateArrReassignment(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  instanceId: number,
): Promise<VersionDeletionPlan['eligibleArrReassignments'][number]> {
  const selectedIds = new Set(snapshot.selectedMediaIds ?? [snapshot.mediaId!]);
  const excludedIds = new Set(snapshot.operationMediaIds ?? [...selectedIds]);
  const retainedMediaId = persistedRetainedMediaId(snapshot);
  if (retainedMediaId === null) throw new Error('The Arr reassignment plan is incomplete');
  const [liveVersions, arrTargets, live] = await Promise.all([
    client.mediaVersionPathPreviews(snapshot.ratingKey),
    getArrDeleteTargets(target.serverId, snapshot.libraryKey),
    client.metadataIdentity(snapshot.ratingKey),
  ]);
  if (!live) throw new Error('The retained Plex item disappeared during Arr reassignment');
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
    serverId: target.serverId,
    libraryKey: snapshot.libraryKey,
    plexClient: client,
    versionRanks: live.media,
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

  await validateLiveDeletionIdentity(client, target.targetKind, snapshot, live);
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
  if (mediaRatingKeyIsPlaying(snapshot.ratingKey, await client.activeSessions())) {
    throw new Error('cannot delete a media version during active playback');
  }
  const entry = plan.eligibleArrReassignments.find((candidate) =>
    candidate.target.instanceId === instanceId
  );
  if (!entry) throw new Error('A required Arr reassignment instance could not be verified');
  return entry;
}

function originalMonitored(entry: PersistedArrReassignment): boolean {
  if (
    !Object.hasOwn(entry, 'originalMonitored') ||
    typeof entry.originalMonitored !== 'boolean'
  ) {
    throw new Error('The durable Arr reassignment monitoring state is missing or malformed');
  }
  return entry.originalMonitored;
}

function oldManagedFileIsPresent(
  entry: VersionDeletionPlan['eligibleArrReassignments'][number],
  persisted: PersistedArrReassignment,
): boolean {
  return entry.managedFileId === persisted.managedFileId &&
    sameRemotePath(entry.managedPath, persisted.managedPath);
}

function retainedFileIsAdopted(
  entry: VersionDeletionPlan['eligibleArrReassignments'][number],
  persisted: PersistedArrReassignment,
): boolean {
  if (
    !sameRemotePath(entry.managedPath, persisted.retainedPath) ||
    entry.managedFileId === null || entry.managedFileId === persisted.managedFileId
  ) return false;
  return persisted.instanceType === 'radarr'
    ? radarrBytesMatchProjectedKilobytes(entry.managedFileSize, persisted.retainedFileSize)
    : Number.isSafeInteger(persisted.retainedFileSize) && persisted.retainedFileSize! > 0 &&
      entry.managedFileSize === persisted.retainedFileSize;
}

async function setExactMonitoring(
  entry: VersionDeletionPlan['eligibleArrReassignments'][number],
  persisted: PersistedArrReassignment,
  snapshot: DurableTargetSnapshot,
  monitored: boolean,
): Promise<void> {
  if (persisted.instanceType === 'radarr') {
    if (snapshot.tmdbId === null) throw new Error('The persisted Radarr identity is incomplete');
    await entry.target.client.setRadarrMovieMonitored({
      movieId: persisted.recordId,
      tmdbId: snapshot.tmdbId,
      path: entry.recordPath,
    }, monitored);
  } else {
    if (
      persisted.episodeId === null || snapshot.seasonIndex === null ||
      snapshot.seasonIndex === undefined || snapshot.episodeIndex === null ||
      snapshot.episodeIndex === undefined
    ) throw new Error('The persisted Sonarr episode identity is incomplete');
    await entry.target.client.setSonarrEpisodeMonitored({
      episodeId: persisted.episodeId,
      seriesId: persisted.recordId,
      seasonNumber: snapshot.seasonIndex,
      episodeNumber: snapshot.episodeIndex,
    }, monitored);
  }
}

function persistMonitoringUpgrade(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  monitoredByInstance: ReadonlyMap<number, boolean>,
): void {
  const expectedSnapshot = JSON.stringify(snapshot);
  const upgraded = (snapshot.arrReassignments ?? []).map((persisted) =>
    Object.hasOwn(persisted, 'originalMonitored') ? persisted : {
      ...persisted,
      originalMonitored: monitoredByInstance.get(persisted.instanceId),
    }
  );
  if (upgraded.some((entry) => typeof entry.originalMonitored !== 'boolean')) {
    throw new Error('Legacy Arr reassignment monitoring state could not be captured safely');
  }
  const next = { ...snapshot, arrReassignments: upgraded as PersistedArrReassignment[] };
  const updated = withTransaction((db) =>
    db.prepare(
      "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running' AND snapshot = ?",
    ).run(
      JSON.stringify(next),
      Math.floor(Date.now() / 1000),
      target.id,
      expectedSnapshot,
    )
  );
  if (updated !== 1) {
    throw new DeletionConvergenceError('Could not persist legacy Arr monitoring evidence');
  }
  snapshot.arrReassignments = next.arrReassignments;
}

function persistRadarrMonitoringTransition(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  instanceId: number,
  field: 'monitoringProtectionAttemptedAt' | 'monitoringProtectedAt',
): void {
  const before = JSON.stringify(snapshot);
  const next = structuredClone(snapshot);
  const entry = next.arrReassignments?.find((candidate) => candidate.instanceId === instanceId);
  if (!entry?.radarrPathPlan || entry.radarrPathPlan.mode === 'existing_path') return;
  entry.radarrPathPlan.transition = {
    ...entry.radarrPathPlan.transition,
    [field]: Math.floor(Date.now() / 1000),
  };
  const now = Math.floor(Date.now() / 1000);
  const changed = withTransaction((db) =>
    db.prepare(
      "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running' AND snapshot = ?",
    ).run(JSON.stringify(next), now, target.id, before)
  );
  if (changed !== 1) {
    throw new DeletionConvergenceError('Could not persist Radarr monitoring progress');
  }
  snapshot.arrReassignments = next.arrReassignments;
  target.snapshot = JSON.stringify(next);
}

export async function ensureArrMonitoringEvidence(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
): Promise<void> {
  const persistedEntries = snapshot.arrReassignments ?? [];
  if (persistedEntries.length === 0) throw new Error('The Arr reassignment plan is incomplete');
  const monitoredByInstance = new Map<number, boolean>();
  let needsUpgrade = false;
  for (const persisted of persistedEntries) {
    if (Object.hasOwn(persisted, 'originalMonitored')) {
      if (typeof persisted.originalMonitored !== 'boolean') {
        throw new Error('The durable Arr reassignment monitoring state is malformed');
      }
      continue;
    }
    needsUpgrade = true;
    const entry = await revalidateArrReassignment(target, snapshot, client, persisted.instanceId);
    if (!oldManagedFileIsPresent(entry, persisted)) {
      throw new Error(
        'Legacy Arr reassignment cannot recover the original monitoring state after the selected file disappeared',
      );
    }
    monitoredByInstance.set(persisted.instanceId, entry.monitored);
  }
  if (needsUpgrade) persistMonitoringUpgrade(target, snapshot, monitoredByInstance);
}

export async function ensureArrReassignmentProtected(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  persisted: PersistedArrReassignment,
  // Radarr's managed-file row remains present until RescanMovie even after
  // Plex has authoritatively removed the selected physical file.
  selectedPlexFileRemoved = false,
): Promise<VersionDeletionPlan['eligibleArrReassignments'][number]> {
  const original = originalMonitored(persisted);
  let entry = await revalidateArrReassignment(target, snapshot, client, persisted.instanceId);
  const alreadyAdopted = retainedFileIsAdopted(entry, persisted);
  const outsidePathPlan = persisted.radarrPathPlan?.mode !== undefined &&
    persisted.radarrPathPlan.mode !== 'existing_path';
  const protectionAttempted =
    persisted.radarrPathPlan?.transition?.monitoringProtectionAttemptedAt !== undefined;
  if (
    outsidePathPlan && !protectionAttempted && !alreadyAdopted &&
    oldManagedFileIsPresent(entry, persisted) && entry.monitored !== original
  ) {
    throw new Error(`${entry.target.instanceName} monitoring changed before file deletion`);
  }
  if (entry.monitored) {
    if (
      !original && !selectedPlexFileRemoved && !alreadyAdopted &&
      oldManagedFileIsPresent(entry, persisted)
    ) {
      throw new Error(`${entry.target.instanceName} monitoring changed before file deletion`);
    }
    if (outsidePathPlan && !protectionAttempted) {
      persistRadarrMonitoringTransition(
        target,
        snapshot,
        persisted.instanceId,
        'monitoringProtectionAttemptedAt',
      );
    }
    await setExactMonitoring(entry, persisted, snapshot, false);
    entry = await revalidateArrReassignment(target, snapshot, client, persisted.instanceId);
  }
  if (entry.monitored !== false) {
    throw new DeletionConvergenceError(
      `${entry.target.instanceName} did not retain the protective unmonitored state`,
    );
  }
  if (
    outsidePathPlan &&
    persisted.radarrPathPlan?.transition?.monitoringProtectedAt === undefined
  ) {
    persistRadarrMonitoringTransition(
      target,
      snapshot,
      persisted.instanceId,
      'monitoringProtectedAt',
    );
  }
  return entry;
}

export async function restoreArrReassignmentMonitoring(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  persisted: PersistedArrReassignment,
): Promise<void> {
  const original = originalMonitored(persisted);
  let entry = await revalidateArrReassignment(target, snapshot, client, persisted.instanceId);
  if (!retainedFileIsAdopted(entry, persisted)) {
    if (
      sameRemotePath(entry.managedPath, persisted.retainedPath) &&
      entry.managedFileId !== null && entry.managedFileId !== persisted.managedFileId
    ) {
      throw new PlexReconciliationError(
        `${entry.target.instanceName} failed exact retained-file adoption metadata validation`,
        true,
        false,
      );
    }
    throw new DeletionConvergenceError(
      `${entry.target.instanceName} has not adopted the retained version; the target remains intentionally unmonitored to prevent a replacement download`,
    );
  }
  if (entry.monitored !== original) {
    await setExactMonitoring(entry, persisted, snapshot, original);
    entry = await revalidateArrReassignment(target, snapshot, client, persisted.instanceId);
  }
  if (entry.monitored !== original) {
    throw new DeletionConvergenceError(
      `${entry.target.instanceName} did not restore the original monitored state`,
    );
  }
}

export async function reconcileArrReassignmentFinalState(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
): Promise<void> {
  try {
    await ensureArrMonitoringEvidence(target, snapshot, client);
    for (const persisted of snapshot.arrReassignments ?? []) {
      await restoreArrReassignmentMonitoring(target, snapshot, client, persisted);
    }
  } catch (error) {
    if (target.phase !== 'plex_reconciliation') throw error;
    throw new ArrMonitoringReconciliationError(
      error instanceof Error ? error.message : String(error),
      error instanceof PlexReconciliationError && error.permanent,
    );
  }
}

export async function radarrReassignmentAlreadyAdopted(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  useFreshProjectedSize = false,
): Promise<boolean> {
  for (const persisted of snapshot.arrReassignments ?? []) {
    if (persisted.instanceType !== 'radarr') return false;
    const entry = await revalidateArrReassignment(
      target,
      snapshot,
      client,
      persisted.instanceId,
    );
    const projectedSize = useFreshProjectedSize
      ? entry.candidateFileSizes.get(persisted.retainedMediaId)
      : persisted.retainedFileSize;
    const outsidePathPlan = persisted.radarrPathPlan?.mode !== undefined &&
      persisted.radarrPathPlan.mode !== 'existing_path';
    const expectedRecordPath = outsidePathPlan
      ? persisted.radarrPathPlan!.targetMoviePath
      : persisted.recordPath;
    const oldPathVisibility = await entry.target.client.fileVisibility(persisted.managedPath);
    if (
      !sameRemotePath(entry.recordPath, expectedRecordPath) ||
      !sameRemotePath(entry.managedPath, persisted.retainedPath) ||
      entry.managedFileId === null || entry.managedFileId === persisted.managedFileId ||
      !radarrBytesMatchProjectedKilobytes(entry.managedFileSize, projectedSize) ||
      (outsidePathPlan ? oldPathVisibility === 'file' : oldPathVisibility !== 'folder') ||
      await entry.target.client.fileVisibility(persisted.retainedPath) !== 'file'
    ) return false;
  }
  return (snapshot.arrReassignments?.length ?? 0) > 0;
}

export async function waitForArrManagedPath(
  target: DeletionWorkTarget,
  plan: VersionDeletionPlan,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  retainMediaId: number,
): Promise<void> {
  persistArrReassignmentPlan(target.id, snapshot, plan, retainMediaId);
  await ensureArrMonitoringEvidence(target, snapshot, client);
  for (const persisted of snapshot.arrReassignments!) {
    if (persisted.instanceType !== 'sonarr') {
      throw new Error('Radarr reassignment must use the Plex-first coordination path');
    }
    let entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
    const desiredPath = persisted.retainedPath;
    if (retainedFileIsAdopted(entry, persisted)) {
      await restoreArrReassignmentMonitoring(target, snapshot, client, persisted);
      continue;
    }
    if (!entry.alreadyReassigned && entry.managedFileId !== null) {
      entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
      if (!oldManagedFileIsPresent(entry, persisted)) {
        throw new Error(`${entry.target.instanceName} changed its managed file before deletion`);
      }
      const managedFileId = entry.managedFileId;
      if (managedFileId === null) {
        throw new Error(`${entry.target.instanceName} managed file disappeared before deletion`);
      }
      try {
        await entry.target.client.deleteManagedFile(managedFileId);
      } catch (error) {
        entry = await revalidateArrReassignment(target, snapshot, client, persisted.instanceId);
        if (oldManagedFileIsPresent(entry, persisted)) {
          if (!(error instanceof ArrApiError) || error.status !== 404) throw error;
        }
      }
    }
    entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
    if (oldManagedFileIsPresent(entry, persisted)) {
      throw new DeletionConvergenceError(`${entry.target.instanceName} still reports the old file`);
    }
    try {
      await entry.target.client.rescanMedia(entry.recordId);
    } catch (error) {
      if (error instanceof ArrApiError && error.status !== undefined) {
        throw new ArrApiError(
          `${error.message}; the episode remains intentionally unmonitored to prevent a replacement download`,
          error.status,
        );
      }
    }

    let converged = false;
    for (let attempt = 0; attempt < ARR_CONVERGENCE_MAX_ATTEMPTS; attempt++) {
      entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
      if (sameRemotePath(entry.managedPath, desiredPath)) {
        if (entry.managedFileId === null || entry.managedFileId === persisted.managedFileId) {
          throw new Error(
            `${entry.target.instanceName} did not create a new managed-file record`,
          );
        }
        if (
          !Number.isSafeInteger(persisted.retainedFileSize) || persisted.retainedFileSize! <= 0 ||
          entry.managedFileSize !== persisted.retainedFileSize
        ) {
          throw new Error(
            `${entry.target.instanceName} reported unexpected metadata for the retained file; the episode remains intentionally unmonitored pending safe adoption`,
          );
        }
        converged = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, ARR_CONVERGENCE_POLL_INTERVAL_MS));
    }
    if (!converged) {
      throw new DeletionConvergenceError(
        `${entry.target.instanceName} did not adopt the retained Plex version; the episode remains intentionally unmonitored to prevent a replacement download`,
      );
    }
    await restoreArrReassignmentMonitoring(target, snapshot, client, persisted);
  }
}

export async function waitForRadarrManagedPath(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
): Promise<void> {
  await ensureArrMonitoringEvidence(target, snapshot, client);
  for (const persisted of snapshot.arrReassignments ?? []) {
    if (persisted.instanceType !== 'radarr') {
      throw new Error('The persisted reassignment is not a Radarr movie');
    }
    let entry = await ensureArrReassignmentProtected(
      target,
      snapshot,
      client,
      persisted,
      true,
    );
    const adopted = () =>
      sameRemotePath(entry.managedPath, persisted.retainedPath) &&
      entry.managedFileId !== null && entry.managedFileId !== persisted.managedFileId &&
      radarrBytesMatchProjectedKilobytes(
        entry.managedFileSize,
        persisted.retainedFileSize,
      );
    if (adopted()) {
      if (
        await entry.target.client.fileVisibility(persisted.managedPath) !== 'folder' ||
        await entry.target.client.fileVisibility(persisted.retainedPath) !== 'file'
      ) {
        throw new Error(
          `${entry.target.instanceName} reported unexpected live file state; the movie remains intentionally unmonitored pending safe adoption`,
        );
      }
      await restoreArrReassignmentMonitoring(target, snapshot, client, persisted);
      continue;
    }
    if (
      await entry.target.client.fileVisibility(persisted.managedPath) !== 'folder' ||
      await entry.target.client.fileVisibility(persisted.retainedPath) !== 'file'
    ) {
      throw new Error(
        `${entry.target.instanceName} could not verify exact selected-file absence and retained-file visibility; the movie remains intentionally unmonitored pending safe adoption`,
      );
    }
    entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted, true);
    try {
      await entry.target.client.rescanMedia(entry.recordId);
    } catch (error) {
      // A transport failure can leave command acceptance ambiguous, so reconcile
      // through exact live adoption. A definite HTTP rejection is authoritative
      // and retains its bounded upstream detail for the operation error.
      if (error instanceof ArrApiError && error.status !== undefined) {
        throw new ArrApiError(
          `${error.message}; the movie remains intentionally unmonitored to prevent a replacement download`,
          error.status,
        );
      }
    }

    let converged = false;
    for (let attempt = 0; attempt < ARR_CONVERGENCE_MAX_ATTEMPTS; attempt++) {
      entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted, true);
      if (sameRemotePath(entry.managedPath, persisted.retainedPath)) {
        if (entry.managedFileId === null || entry.managedFileId === persisted.managedFileId) {
          throw new Error(
            `${entry.target.instanceName} did not create a new managed-file record; the movie remains intentionally unmonitored pending safe adoption`,
          );
        }
        if (
          !radarrBytesMatchProjectedKilobytes(
            entry.managedFileSize,
            persisted.retainedFileSize,
          )
        ) {
          throw new Error(
            `${entry.target.instanceName} reported unexpected metadata for the retained file; the movie remains intentionally unmonitored pending safe adoption`,
          );
        }
        if (
          await entry.target.client.fileVisibility(persisted.managedPath) !== 'folder' ||
          await entry.target.client.fileVisibility(persisted.retainedPath) !== 'file'
        ) {
          throw new Error(
            `${entry.target.instanceName} reported unexpected live file state after rescan; the movie remains intentionally unmonitored pending safe adoption`,
          );
        }
        converged = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, ARR_CONVERGENCE_POLL_INTERVAL_MS));
    }
    if (!converged) {
      throw new DeletionConvergenceError(
        `${entry.target.instanceName} did not adopt the retained Plex version; the movie remains intentionally unmonitored to prevent a replacement download`,
      );
    }
    await restoreArrReassignmentMonitoring(target, snapshot, client, persisted);
  }
}
