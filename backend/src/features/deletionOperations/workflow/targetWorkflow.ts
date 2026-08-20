import { and, eq, inArray } from 'drizzle-orm';
import { db, withTransaction } from '../../../db/index.ts';
import {
  arrDeleteAttempts,
  downloadFileDeleteAttempts,
  items,
  torrentDeleteAttempts,
} from '../../../db/schema.ts';
import { tryAcquireLibraryOperation } from '../../../services/libraryOperations.ts';
import {
  arrDeleteDisposition,
  type ArrDeleteTarget,
  assertArrDeleteIsUnambiguous,
  type CoordinatedDeleteItem,
  deleteThroughArr,
  findAmbiguousExternalIds,
  getArrDeleteTargets,
} from '../../arr/delete.ts';
import { activeWholeItemRatingKeys } from '../../mediaDeletion/activePlayback.ts';
import {
  confirmedAttemptedDownloadJobAbsences,
  executeDownloadedFileCleanup,
  persistResolvedCleanup,
  reconcileSharedDownloadCleanups,
  rehydrateResolvedCleanup,
  type ResolvedCleanupItem,
  resolveDownloadCleanup,
  selectVerifiedDownloadCleanups,
} from '../../mediaDeletion/cleanup.ts';
import {
  completedOrphanFileAttempt,
  normalizeRemoteAbsolute,
  orphanRootIdentity,
} from '../../mediaDeletion/hardlinks.ts';
import {
  loadAttemptedArrInstancesByItem,
  loadAttemptedDownloadJobKeysByItem,
  loadAttemptedOrphanFilesByItem,
  resolveDownloadCleanupBatch,
} from '../../mediaDeletion/planning.ts';
import { getDownloadClientTargets } from '../../mediaDeletion/targets.ts';
import {
  buildVersionDeletionPlan,
  selectVersionDownloadCleanup,
  type VersionDeletionPlan,
} from '../../mediaDeletion/versionPlanning.ts';
import {
  assertAcceptedArrMappingsUnchanged,
  assertAcceptedSonarrMutationVersion,
  assertVersionIsNotPlaying,
  bestLiveReassignmentCandidate,
  directPlexDeletionStillSafe,
  persistArrOwnershipPlan,
  persistedArrOwnershipMap,
  persistedArrReassignmentMap,
  persistedRetainedMediaId,
  protectArrReassignmentBeforeDownloadCleanup,
  reconcileArrReassignmentFinalState,
  restoreArrReassignmentAfterSafeDownloadFailure,
} from '../arr/arrReassignment.ts';
import { waitForSonarrManagedPath } from '../arr/sonarrReassignmentWorkflow.ts';
import { advancePhase, confirmReassignedRemoval } from '../core/deletionState.ts';
import { reconcilePlexTarget } from './plexReconciliation.ts';
import {
  coordinateRadarrReassignment,
  tryRecoverRadarrWithoutSelectedProjection,
} from '../arr/radarrReassignmentWorkflow.ts';
import {
  assertRadarrRemovalPlexVersions,
  coordinateRadarrRemovalFallback,
} from '../arr/radarrRemovalWorkflow.ts';
import {
  DeletionConvergenceError,
  type DeletionWorkTarget,
  PlexReconciliationError,
} from '../core/types.ts';
import {
  assertWholeSeasonPlexEvidence,
  assertWholeSeasonPlexMembership,
  type DurableTargetSnapshot,
  validateDeletionTarget,
} from '../core/validation.ts';
import { ArrApiError } from '../../../integrations/arr/client.ts';

function persistRadarrRemovalDownloadCleanup(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  cleanup: ResolvedCleanupItem,
): void {
  const before = JSON.stringify(snapshot);
  const next = structuredClone(snapshot);
  next.radarrRemovalDownloadCleanup = persistResolvedCleanup(cleanup);
  const now = Math.floor(Date.now() / 1000);
  const changed = withTransaction((client) =>
    client
      .prepare(
        "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running' AND snapshot = ?",
      )
      .run(JSON.stringify(next), now, target.id, before)
  );
  if (changed !== 1) {
    throw new DeletionConvergenceError('Could not persist the Radarr removal cleanup plan');
  }
  snapshot.radarrRemovalDownloadCleanup = next.radarrRemovalDownloadCleanup;
  target.snapshot = JSON.stringify(next);
}

function externalId(item: CoordinatedDeleteItem): number | null {
  return item.type === 'movie' ? item.tmdbId : item.type === 'show' ? item.tvdbId : null;
}

function assertAcceptedSeasonCoordination(
  snapshot: DurableTargetSnapshot,
  plan: VersionDeletionPlan,
): void {
  const expected = snapshot.seasonCoordinationOutcome;
  if (expected === undefined) return;
  if (!plan.arrOwnershipValid) {
    throw new Error(plan.arrOwnershipReason ?? 'The accepted Sonarr ownership changed');
  }
  const managed = plan.arrManagedMediaIds.includes(snapshot.mediaId!);
  const alreadyAdopted = plan.eligibleArrReassignments.some((entry) => entry.alreadyReassigned);
  if (expected === 'plex_only' && managed) {
    throw new Error('Sonarr ownership changed after Plex-only fallback was accepted');
  }
  if (
    expected === 'automatic_adoption' &&
    (!managed && !alreadyAdopted || plan.preview.arrReassignStatus !== 'resolved')
  ) {
    throw new Error(
      plan.preview.arrReassignReason ?? 'The accepted Sonarr retained-version adoption changed',
    );
  }
  if (expected === 'removed_and_unmonitored' && !managed) {
    throw new Error('The accepted Sonarr-managed version is no longer managed as expected');
  }
}

function persistBreakGlassProgress(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  field: 'monitoringProtectedAt' | 'fileRemovalAttemptedAt' | 'fileRemovalConfirmedAt',
): void {
  const before = JSON.stringify(snapshot);
  const next = structuredClone(snapshot);
  if (!next.seasonBreakGlass) throw new Error('Break-glass Sonarr evidence is missing');
  next.seasonBreakGlass[field] = Math.floor(Date.now() / 1000);
  const changed = withTransaction((db) =>
    db.prepare(
      "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running') AND snapshot = ?",
    ).run(JSON.stringify(next), Math.floor(Date.now() / 1000), target.id, before)
  );
  if (changed !== 1) {
    throw new DeletionConvergenceError('Could not persist Sonarr recovery progress');
  }
  snapshot.seasonBreakGlass = next.seasonBreakGlass;
  target.snapshot = JSON.stringify(next);
}

async function protectBreakGlassEpisode(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): Promise<ArrDeleteTarget> {
  const evidence = snapshot.seasonBreakGlass;
  if (!evidence) throw new Error('Break-glass Sonarr evidence is missing');
  const targets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
  assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, targets);
  const sonarr = targets.find((candidate) =>
    candidate.instanceType === 'sonarr' && candidate.instanceId === evidence.instanceId
  );
  if (!sonarr) throw new Error('The accepted Sonarr instance is unavailable');
  await assertAcceptedSonarrMutationVersion(snapshot, sonarr);
  let state = await sonarr.client.sonarrSeriesSnapshot(evidence.seriesId);
  let episode = state.episodes.find((candidate) => candidate.id === evidence.episodeId);
  const file = episode?.episodeFileId === evidence.episodeFileId
    ? state.files.find((candidate) => candidate.id === evidence.episodeFileId)
    : null;
  const removedAfterAttempt = evidence.fileRemovalAttemptedAt !== undefined &&
    episode?.episodeFileId === 0 &&
    !state.files.some((candidate) => candidate.id === evidence.episodeFileId);
  if (
    !episode || episode.seriesId !== evidence.seriesId ||
    episode.seasonNumber !== snapshot.seasonIndex ||
    episode.episodeNumber !== snapshot.episodeIndex ||
    (!removedAfterAttempt &&
      (!file || file.path !== evidence.episodeFilePath ||
        file.size !== evidence.episodeFileSize || file.episodeIds.length !== 1 ||
        file.episodeIds[0] !== evidence.episodeId))
  ) {
    throw new Error(
      'The accepted Sonarr episode or EpisodeFile identity changed before monitoring protection',
    );
  }
  if (removedAfterAttempt && episode.monitored !== false) {
    throw new Error('Sonarr monitoring changed after the accepted EpisodeFile removal attempt');
  }
  if (episode.monitored) {
    await sonarr.client.setSonarrEpisodeMonitored({
      episodeId: evidence.episodeId,
      seriesId: evidence.seriesId,
      seasonNumber: snapshot.seasonIndex!,
      episodeNumber: snapshot.episodeIndex!,
    }, false);
    state = await sonarr.client.sonarrSeriesSnapshot(evidence.seriesId);
    episode = state.episodes.find((candidate) => candidate.id === evidence.episodeId);
  }
  if (!episode || episode.monitored !== false) {
    throw new DeletionConvergenceError('Sonarr did not retain the protective unmonitored state');
  }
  if (evidence.monitoringProtectedAt === undefined) {
    persistBreakGlassProgress(target, snapshot, 'monitoringProtectedAt');
  }
  return sonarr;
}

async function completeBreakGlassRemoval(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): Promise<void> {
  const evidence = snapshot.seasonBreakGlass!;
  const sonarr = await protectBreakGlassEpisode(target, snapshot);
  let state = await sonarr.client.sonarrSeriesSnapshot(evidence.seriesId);
  const episode = state.episodes.find((candidate) => candidate.id === evidence.episodeId);
  if (!episode) throw new Error('The accepted Sonarr episode identity changed');
  if (episode.episodeFileId !== 0) {
    const file = state.files.find((candidate) => candidate.id === episode.episodeFileId);
    if (
      !file || file.id !== evidence.episodeFileId || file.path !== evidence.episodeFilePath ||
      file.size !== evidence.episodeFileSize || file.episodeIds.length !== 1 ||
      file.episodeIds[0] !== evidence.episodeId
    ) {
      throw new Error('The accepted Sonarr EpisodeFile identity changed');
    }
    if (evidence.fileRemovalAttemptedAt === undefined) {
      persistBreakGlassProgress(target, snapshot, 'fileRemovalAttemptedAt');
    }
    try {
      await sonarr.client.deleteManagedFile(evidence.episodeFileId);
    } catch {
      // Reconcile exact record absence after a potentially ambiguous response.
    }
  }
  state = await sonarr.client.sonarrSeriesSnapshot(evidence.seriesId);
  const after = state.episodes.find((candidate) => candidate.id === evidence.episodeId);
  if (
    !after || after.monitored !== false || after.episodeFileId !== 0 ||
    state.files.some((candidate) => candidate.id === evidence.episodeFileId) ||
    await sonarr.client.fileVisibility(evidence.episodeFilePath) !== 'missing'
  ) {
    throw new DeletionConvergenceError(
      'Sonarr removal did not converge to exact record and path absence; the episode remains intentionally unmonitored',
    );
  }
  if (evidence.fileRemovalConfirmedAt === undefined) {
    persistBreakGlassProgress(target, snapshot, 'fileRemovalConfirmedAt');
  }
}

async function restoreBreakGlassMonitoringAfterSafeDownloadFailure(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): Promise<void> {
  const evidence = snapshot.seasonBreakGlass;
  if (!evidence) throw new Error('Break-glass Sonarr evidence is missing');
  const targets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
  assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, targets);
  const sonarr = targets.find((candidate) =>
    candidate.instanceType === 'sonarr' && candidate.instanceId === evidence.instanceId
  );
  if (!sonarr) throw new Error('The accepted Sonarr instance is unavailable');
  await assertAcceptedSonarrMutationVersion(snapshot, sonarr);
  let state = await sonarr.client.sonarrSeriesSnapshot(evidence.seriesId);
  let episode = state.episodes.find((candidate) => candidate.id === evidence.episodeId);
  const file = episode?.episodeFileId === evidence.episodeFileId
    ? state.files.find((candidate) => candidate.id === evidence.episodeFileId)
    : null;
  if (
    !episode || !file || file.path !== evidence.episodeFilePath ||
    file.size !== evidence.episodeFileSize || file.episodeIds.length !== 1 ||
    file.episodeIds[0] !== evidence.episodeId
  ) {
    throw new DeletionConvergenceError(
      'The old Sonarr EpisodeFile changed before monitoring could be restored',
    );
  }
  if (episode.monitored !== evidence.originalMonitored) {
    await sonarr.client.setSonarrEpisodeMonitored({
      episodeId: evidence.episodeId,
      seriesId: evidence.seriesId,
      seasonNumber: snapshot.seasonIndex!,
      episodeNumber: snapshot.episodeIndex!,
    }, evidence.originalMonitored);
    state = await sonarr.client.sonarrSeriesSnapshot(evidence.seriesId);
    episode = state.episodes.find((candidate) => candidate.id === evidence.episodeId);
  }
  if (
    !episode || episode.monitored !== evidence.originalMonitored ||
    episode.episodeFileId !== evidence.episodeFileId
  ) {
    throw new DeletionConvergenceError(
      'Sonarr did not restore the original monitored state after download cleanup stopped safely',
    );
  }
}

interface ProtectedSeasonPayloadTarget {
  target: DeletionWorkTarget;
  snapshot: DurableTargetSnapshot;
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'];
  mode: 'automatic_adoption' | 'removed_and_unmonitored';
}

function persistSeasonPayloadProtection(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): void {
  const before = JSON.stringify(snapshot);
  const next = structuredClone(snapshot);
  const transitions =
    next.arrReassignments?.flatMap((entry) =>
      entry.instanceType === 'sonarr' && entry.sonarrTransition ? [entry.sonarrTransition] : []
    ) ?? [];
  if (transitions.length === 0) {
    throw new Error('The durable Sonarr payload-protection plan is incomplete');
  }
  const protectedAt = Math.floor(Date.now() / 1000);
  for (const transition of transitions) transition.payloadProtectionAt = protectedAt;
  const changed = withTransaction((client) =>
    client.prepare(
      "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running') AND snapshot = ?",
    ).run(JSON.stringify(next), protectedAt, target.id, before)
  );
  if (changed !== 1) {
    throw new DeletionConvergenceError('Could not persist Sonarr payload protection');
  }
  Object.assign(snapshot, next);
  target.snapshot = JSON.stringify(next);
}

function activeSeasonOperationTargets(operationId: string): DeletionWorkTarget[] {
  return withTransaction((client) =>
    client.prepare(
      `SELECT t.id, t.operation_id, o.server_id, t.target_kind, t.target_key, t.snapshot,
              t.logical_size, t.phase, t.removal_confirmed_at, t.plex_attempt_count
       FROM deletion_targets t
       JOIN deletion_operations o ON o.id = t.operation_id
       WHERE t.operation_id = ? AND t.status IN ('queued', 'running')
       ORDER BY t.ordinal`,
    ).values(operationId).map((row) => ({
      id: Number(row[0]),
      operationId: String(row[1]),
      serverId: Number(row[2]),
      targetKind: String(row[3]) as DeletionWorkTarget['targetKind'],
      targetKey: String(row[4]),
      snapshot: String(row[5]),
      logicalSize: row[6] === null ? null : Number(row[6]),
      phase: String(row[7]) as DeletionWorkTarget['phase'],
      removalConfirmedAt: row[8] === null ? null : Number(row[8]),
      plexAttemptCount: Number(row[9]),
    }))
  );
}

async function protectSeasonPayloadTargetsBeforeDownloadCleanup(
  owner: DeletionWorkTarget,
  ownerSnapshot: DurableTargetSnapshot,
  cleanup: ResolvedCleanupItem,
): Promise<ProtectedSeasonPayloadTarget[]> {
  const payloadPaths = new Set(cleanup.sources.flatMap((source) => {
    const path = source.importedPath === null
      ? null
      : normalizeRemoteAbsolute(source.importedPath)?.comparison;
    return path ? [path] : [];
  }));
  if (payloadPaths.size === 0) {
    throw new Error('The shared season download payload has no exact Plex path ownership');
  }
  const matchedPaths = new Set<string>();
  const protectedTargets: ProtectedSeasonPayloadTarget[] = [];
  try {
    for (const sibling of activeSeasonOperationTargets(owner.operationId)) {
      const snapshot = sibling.id === owner.id
        ? ownerSnapshot
        : JSON.parse(sibling.snapshot) as DurableTargetSnapshot;
      if (sibling.id === owner.id) sibling.snapshot = owner.snapshot;
      const selectedPath = snapshot.expectedPlexPath === undefined
        ? null
        : normalizeRemoteAbsolute(snapshot.expectedPlexPath)?.comparison ?? null;
      if (!selectedPath || !payloadPaths.has(selectedPath)) continue;
      matchedPaths.add(selectedPath);
      if (
        snapshot.seasonCoordinationOutcome !== 'automatic_adoption' &&
        snapshot.seasonCoordinationOutcome !== 'removed_and_unmonitored'
      ) continue;
      const validated = await validateDeletionTarget(sibling.serverId, sibling);
      if (!validated.live) {
        throw new Error('A selected season payload target disappeared from Plex');
      }
      await assertVersionIsNotPlaying(validated.client, snapshot.ratingKey);
      if (snapshot.seasonCoordinationOutcome === 'removed_and_unmonitored') {
        protectedTargets.push({
          target: sibling,
          snapshot,
          client: validated.client,
          mode: 'removed_and_unmonitored',
        });
        await protectBreakGlassEpisode(sibling, snapshot);
        sibling.snapshot = JSON.stringify(snapshot);
        continue;
      }
      const selectedIds = new Set(snapshot.selectedMediaIds ?? [snapshot.mediaId!]);
      const excludedIds = new Set(snapshot.operationMediaIds ?? [...selectedIds]);
      const [liveVersions, arrTargets] = await Promise.all([
        validated.client.mediaVersionPathPreviews(snapshot.ratingKey),
        getArrDeleteTargets(sibling.serverId, snapshot.libraryKey),
      ]);
      const plan = await buildVersionDeletionPlan({
        mediaType: 'episode',
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
        serverId: sibling.serverId,
        libraryKey: snapshot.libraryKey,
        plexClient: validated.client,
        versionRanks: validated.live.media,
        episodeIdentity: {
          seasonNumber: snapshot.seasonIndex!,
          episodeNumber: snapshot.episodeIndex!,
        },
      });
      assertAcceptedSeasonCoordination(snapshot, plan);
      const candidateMediaId = snapshot.seasonSelectedCandidateMediaId ??
        bestLiveReassignmentCandidate(validated.live, plan.arrReassignCandidateMediaIds);
      if (
        candidateMediaId === null ||
        !plan.arrReassignCandidateMediaIds.includes(candidateMediaId)
      ) throw new Error('A shared season payload has no authorized retained Sonarr candidate');
      protectedTargets.push({
        target: sibling,
        snapshot,
        client: validated.client,
        mode: 'automatic_adoption',
      });
      await protectArrReassignmentBeforeDownloadCleanup(
        sibling,
        plan,
        snapshot,
        validated.client,
        candidateMediaId,
      );
      persistSeasonPayloadProtection(sibling, snapshot);
      sibling.snapshot = JSON.stringify(snapshot);
    }
    if ([...payloadPaths].some((path) => !matchedPaths.has(path))) {
      throw new Error(
        'The shared season download payload is not fully covered by active ordered targets',
      );
    }
  } catch (error) {
    if (protectedTargets.length > 0) {
      await restoreSeasonPayloadProtectionAfterSafeDownloadFailure(protectedTargets);
    }
    throw error;
  }
  return protectedTargets;
}

async function restoreSeasonPayloadProtectionAfterSafeDownloadFailure(
  targets: readonly ProtectedSeasonPayloadTarget[],
): Promise<void> {
  for (const entry of targets) {
    if (entry.mode === 'automatic_adoption') {
      // Persisting the reassignment plan is the first protection step. If that
      // compare-and-swap failed, no monitoring mutation was possible and there
      // is nothing to restore for this target.
      if ((entry.snapshot.arrReassignments?.length ?? 0) > 0) {
        await restoreArrReassignmentAfterSafeDownloadFailure(
          entry.target,
          entry.snapshot,
          entry.client,
        );
      }
    } else {
      await restoreBreakGlassMonitoringAfterSafeDownloadFailure(entry.target, entry.snapshot);
    }
    const before = JSON.stringify(entry.snapshot);
    const next = structuredClone(entry.snapshot);
    delete next.arrReassignments;
    if (next.seasonBreakGlass) {
      delete next.seasonBreakGlass.monitoringProtectedAt;
    }
    const changed = withTransaction((client) =>
      client.prepare(
        "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND snapshot = ?",
      ).run(
        JSON.stringify(next),
        Math.floor(Date.now() / 1000),
        entry.target.id,
        before,
      )
    );
    if (changed === 1) {
      entry.snapshot = next;
      entry.target.snapshot = JSON.stringify(next);
    }
  }
}

async function seasonCleanupHasAttemptEvidence(
  serverId: number,
  attemptRatingKey: string,
  cleanup: ResolvedCleanupItem,
): Promise<boolean> {
  const [attemptedJobsByItem, attemptedOrphansByItem] = await Promise.all([
    loadAttemptedDownloadJobKeysByItem(serverId, [attemptRatingKey]),
    loadAttemptedOrphanFilesByItem(serverId, [attemptRatingKey]),
  ]);
  const attemptedJobs = attemptedJobsByItem.get(attemptRatingKey) ?? new Set<string>();
  if (
    cleanup.downloadJobs.some((job) => attemptedJobs.has(`${job.instanceKey}:${job.jobId}`))
  ) return true;
  const attemptedOrphanPaths = new Set(
    (attemptedOrphansByItem.get(attemptRatingKey) ?? []).map((entry) => entry.path),
  );
  return cleanup.orphanFiles.some((file) => attemptedOrphanPaths.has(file.path));
}

async function markArrAttempt(
  serverId: number,
  snapshot: DurableTargetSnapshot,
  target: ArrDeleteTarget,
): Promise<void> {
  await db
    .insert(arrDeleteAttempts)
    .values({
      serverId,
      ratingKey: snapshot.ratingKey,
      libraryKey: snapshot.libraryKey,
      arrInstanceId: target.instanceId,
      externalId: externalId(snapshot)!,
      startedAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoUpdate({
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
  reconcileAttemptedAbsence = false,
): Promise<void> {
  const attemptRatingKey = attemptParentRatingKey ?? cleanup.ratingKey;
  const confirmedJobAbsences = new Set<string>();
  const confirmedOrphanAbsences = new Set<string>();
  if (reconcileAttemptedAbsence) {
    const [attemptedJobsByItem, attemptedOrphansByItem] = await Promise.all([
      loadAttemptedDownloadJobKeysByItem(serverId, [attemptRatingKey]),
      loadAttemptedOrphanFilesByItem(serverId, [attemptRatingKey]),
    ]);
    const attemptedJobs = attemptedJobsByItem.get(attemptRatingKey) ?? new Set<string>();
    for (const key of await confirmedAttemptedDownloadJobAbsences(cleanup, attemptedJobs)) {
      confirmedJobAbsences.add(key);
    }
    const configuredRoots = new Set(cleanup.orphanFiles.map((file) => file.root));
    for (const attempt of attemptedOrphansByItem.get(attemptRatingKey) ?? []) {
      if (
        cleanup.orphanFiles.some((file) => file.path === attempt.path) &&
        await completedOrphanFileAttempt(attempt, configuredRoots)
      ) {
        confirmedOrphanAbsences.add(attempt.path);
      }
    }
  }
  await executeDownloadedFileCleanup(
    cleanup,
    confirmedJobAbsences,
    confirmedOrphanAbsences,
    async (job) => {
      const jobKey = `${job.instanceKey}:${job.jobId}`;
      for (const [ratingKey, associated] of associations) {
        if (
          !associated.downloadJobs.some(
            (candidate) => `${candidate.instanceKey}:${candidate.jobId}` === jobKey,
          )
        ) {
          continue;
        }
        await db
          .insert(torrentDeleteAttempts)
          .values({
            serverId,
            ratingKey: attemptParentRatingKey ?? ratingKey,
            instanceKey: job.instanceKey,
            torrentHash: job.jobId,
            startedAt: Math.floor(Date.now() / 1000),
          })
          .onConflictDoUpdate({
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
        await db
          .insert(downloadFileDeleteAttempts)
          .values({
            serverId,
            ratingKey: attemptParentRatingKey ?? ratingKey,
            localPath: file.path,
            rootPath: file.root,
            rootDevice: root.rootDevice,
            rootInode: root.rootInode,
            startedAt: Math.floor(Date.now() / 1000),
          })
          .onConflictDoUpdate({
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
    findAmbiguousExternalIds(sqlite, target.serverId, item.type === 'movie' ? 'movie' : 'show', [
      id,
    ])
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
    const selected = await db
      .select({
        ratingKey: items.ratingKey,
        title: items.title,
        type: items.type,
        tmdbId: items.tmdbId,
        tvdbId: items.tvdbId,
      })
      .from(items)
      .where(and(eq(items.serverId, target.serverId), inArray(items.ratingKey, selectedKeys)));
    const downloadTargets = await getDownloadClientTargets(target.serverId);
    const attemptedJobs = await loadAttemptedDownloadJobKeysByItem(target.serverId, selectedKeys);
    const attemptedOrphans = await loadAttemptedOrphanFilesByItem(target.serverId, selectedKeys);
    const attemptedByItem = await loadAttemptedArrInstancesByItem(
      target.serverId,
      selected,
      arrTargets.map((entry) => entry.instanceId),
    );
    const cleanups = selectVerifiedDownloadCleanups(
      reconcileSharedDownloadCleanups(
        await resolveDownloadCleanupBatch(
          selected,
          arrTargets,
          downloadTargets,
          attemptedJobs,
          attemptedOrphans,
          attemptedByItem,
        ),
      ),
    );
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

async function assertWholeSeasonSonarrPostcondition(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  mutate: boolean,
): Promise<void> {
  const plan = snapshot.wholeSeasonRemoval;
  if (!plan) throw new Error('durable whole-season evidence is missing');
  if (snapshot.mode !== 'coordinated') return;
  const configured = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
  for (const expected of plan.sonarrTargets) {
    const matches = configured.filter((candidate) =>
      candidate.instanceType === 'sonarr' && candidate.instanceId === expected.instanceId &&
      candidate.instanceUrl === expected.instanceUrl &&
      candidate.configurationUpdatedAt === expected.configurationUpdatedAt &&
      candidate.mappingIdentity === expected.mappingIdentity
    );
    if (matches.length !== 1) {
      throw new Error('The accepted Sonarr connection or path mapping changed');
    }
    const sonarr = matches[0]!;
    const capabilities = await sonarr.client.sonarrSeasonCoordinationCapabilities();
    if (!capabilities.available || capabilities.version !== expected.version) {
      throw new Error(capabilities.reason ?? 'The accepted Sonarr version changed');
    }
    const series = await sonarr.client.lookup(snapshot.tvdbId!);
    if (!series || series.id !== expected.seriesId || series.path !== expected.seriesPath) {
      throw new Error('The accepted Sonarr series identity changed');
    }
    const activity = await sonarr.client.sonarrSeriesActivity(series.id);
    if (!activity.quiet) {
      throw new Error(
        `Sonarr has conflicting series activity: ${
          activity.blocking.map((entry) => entry.name).join(', ')
        }`,
      );
    }
    let current = await sonarr.client.sonarrSeriesSnapshot(series.id);
    const expectedEpisodeIds = new Set(expected.episodes.map((episode) => episode.episodeId));
    for (const episode of expected.episodes) {
      const live = current.episodes.find((candidate) => candidate.id === episode.episodeId);
      if (
        !live || live.seriesId !== expected.seriesId ||
        live.seasonNumber !== episode.seasonNumber ||
        live.episodeNumber !== episode.episodeNumber ||
        (live.episodeFileId !== episode.episodeFileId && live.episodeFileId !== 0)
      ) throw new Error('The accepted Sonarr season episode identity changed');
    }
    for (const file of expected.files) {
      if (file.episodeIds.some((id) => !expectedEpisodeIds.has(id))) {
        throw new Error('The accepted Sonarr file crosses the season boundary');
      }
      const live = current.files.find((candidate) => candidate.id === file.id);
      if (
        live && (live.seriesId !== expected.seriesId || live.path !== file.path ||
          live.size !== file.size || JSON.stringify([...live.episodeIds].sort((a, b) => a - b)) !==
            JSON.stringify(file.episodeIds))
      ) throw new Error('The accepted Sonarr EpisodeFile identity changed');
    }
    if (mutate) {
      for (const episode of expected.episodes) {
        const live = current.episodes.find((candidate) => candidate.id === episode.episodeId)!;
        if (live.monitored) {
          await sonarr.client.setSonarrEpisodeMonitored({
            episodeId: episode.episodeId,
            seriesId: expected.seriesId,
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
          }, false);
        }
      }
      current = await sonarr.client.sonarrSeriesSnapshot(series.id);
      for (const file of expected.files) {
        if (!current.files.some((candidate) => candidate.id === file.id)) continue;
        try {
          await sonarr.client.deleteManagedFile(file.id);
        } catch (error) {
          if (!(error instanceof ArrApiError && error.status === 404)) throw error;
        }
      }
      current = await sonarr.client.sonarrSeriesSnapshot(series.id);
    }
    if (
      expected.episodes.some((episode) => {
        const live = current.episodes.find((candidate) => candidate.id === episode.episodeId);
        return !live || live.monitored !== false || live.episodeFileId !== 0;
      }) || expected.files.some((file) =>
        current.files.some((candidate) => candidate.id === file.id)
      )
    ) {
      throw new DeletionConvergenceError(
        'Sonarr season removal did not reach its safe final state',
      );
    }
  }
}

async function ensureWholeSeasonDeleted(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  liveAtStart: Awaited<ReturnType<typeof validateDeletionTarget>>['live'],
): Promise<void> {
  if (!snapshot.wholeSeasonRemoval) throw new Error('durable whole-season evidence is missing');
  // A 404 from exact season metadata is already authoritative absence. Preserve the
  // ordinary whole-item recovery path instead of requiring children from a root Plex
  // no longer exposes; live seasons still require byte-for-byte accepted evidence.
  if (target.phase === 'validating' && liveAtStart) {
    await assertWholeSeasonPlexEvidence(client, snapshot);
  }
  if (liveAtStart) {
    const sessions = await client.activeSessions();
    if (
      activeWholeItemRatingKeys(
        new Set(snapshot.wholeSeasonRemoval.episodeRatingKeys),
        sessions,
      ).size > 0
    ) throw new Error('cannot delete a season with active episode playback');
  }
  if (
    snapshot.cleanupDownloads && snapshot.seasonDownloadCleanup &&
    (target.phase === 'validating' || target.phase === 'download_cleanup')
  ) {
    if (target.phase === 'validating') advancePhase(target, 'download_cleanup');
    const cleanup = rehydrateResolvedCleanup(
      snapshot.seasonDownloadCleanup,
      await getDownloadClientTargets(target.serverId),
    );
    await executeCleanup(
      target.serverId,
      new Map([[snapshot.showRatingKey!, cleanup]]),
      cleanup,
      snapshot.showRatingKey!,
      true,
    );
    await assertWholeSeasonPlexMembership(client, snapshot);
  }
  if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');
  await assertWholeSeasonSonarrPostcondition(target, snapshot, true);
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
            snapshot.seasonIndex !== null &&
            snapshot.seasonIndex !== undefined &&
            snapshot.episodeIndex !== null &&
            snapshot.episodeIndex !== undefined
          ? {
            episodeIdentity: {
              seasonNumber: snapshot.seasonIndex,
              episodeNumber: snapshot.episodeIndex,
            },
          }
          : {}),
      });
      assertAcceptedSeasonCoordination(snapshot, plan);
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
    if (snapshot.skipArrCoordination === true) {
      advancePhase(target, 'plex_reconciliation');
      await reconcilePlexTarget(target, snapshot);
      return;
    }
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
          snapshot.seasonIndex !== null &&
          snapshot.seasonIndex !== undefined &&
          snapshot.episodeIndex !== null &&
          snapshot.episodeIndex !== undefined
        ? {
          episodeIdentity: {
            seasonNumber: snapshot.seasonIndex,
            episodeNumber: snapshot.episodeIndex,
          },
        }
        : {}),
    });
    assertAcceptedSeasonCoordination(snapshot, plan);
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

  const interruptedSonarrAdoption = snapshot.seasonCoordinationOutcome ===
      'automatic_adoption' &&
    retainedMediaId !== null &&
    snapshot.arrReassignments?.some((entry) =>
      entry.instanceType === 'sonarr' &&
      entry.sonarrTransition?.oldFileRemovalConfirmedAt !== undefined
    );
  if (interruptedSonarrAdoption) {
    if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');
    await waitForSonarrManagedPath(target, null, snapshot, client, retainedMediaId!);
    confirmReassignedRemoval(target);
    await reconcileArrReassignmentFinalState(target, snapshot, client);
    await reconcilePlexTarget(target, snapshot);
    return;
  }

  if (
    snapshot.seasonCoordinationOutcome === 'removed_and_unmonitored' &&
    snapshot.seasonBreakGlass?.fileRemovalConfirmedAt !== undefined
  ) {
    if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');
    await completeBreakGlassRemoval(target, snapshot);
    advancePhase(target, 'plex_reconciliation');
    await reconcilePlexTarget(target, snapshot);
    return;
  }

  if (snapshot.skipArrCoordination === true) {
    if (target.targetKind === 'movie_version') {
      if (!(await directPlexDeletionStillSafe(target, snapshot, excludedReassignIds))) {
        throw new PlexReconciliationError(
          'at least one unselected live Plex version must remain',
          true,
          false,
        );
      }
      advancePhase(target, 'plex_reconciliation');
      await reconcilePlexTarget(target, snapshot);
      return;
    }
    const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
    assertAcceptedArrMappingsUnchanged(
      target.targetKind,
      snapshot,
      arrTargets,
      snapshot.seasonSonarrInspection?.mappings,
    );
    const inspectedInstanceIds = new Set(
      snapshot.seasonSonarrInspection?.inspectedInstanceIds ??
        snapshot.seasonSonarrInspection?.mappings.map((mapping) => mapping.instanceId) ??
        [],
    );
    const directCleanup = snapshot.cleanupDownloads === true &&
      (snapshot.seasonDownloadCleanup?.downloadJobs.length ?? 0) > 0 &&
      snapshot.seasonDownloadCleanup!.downloadJobs.every((job) =>
        job.provenance === 'direct_manifest'
      );
    // Direct discovery is deliberately independent of Sonarr. Ownership was useful
    // preview context, but a later Sonarr outage must not invalidate qBittorrent's
    // separately persisted manifest, mapping, and filesystem proof.
    const inspectedArrTargets = directCleanup
      ? []
      : arrTargets.filter((candidate) => inspectedInstanceIds.has(candidate.instanceId));
    const inspectedMappings = directCleanup
      ? []
      : snapshot.seasonSonarrInspection?.mappings.filter((mapping) =>
        inspectedInstanceIds.has(mapping.instanceId)
      ) ?? [];
    let inspectionPlan: VersionDeletionPlan | null = null;
    let acceptedCleanup: ResolvedCleanupItem | null = null;
    if (
      inspectedMappings.length > 0 ||
      snapshot.cleanupDownloads === true
    ) {
      const liveVersions = await client.mediaVersionPathPreviews(snapshot.ratingKey);
      if (snapshot.cleanupDownloads === true) {
        if (!snapshot.seasonDownloadCleanup) {
          throw new Error('the accepted season download cleanup is missing');
        }
        acceptedCleanup = rehydrateResolvedCleanup(
          snapshot.seasonDownloadCleanup,
          await getDownloadClientTargets(target.serverId),
        );
      }
      inspectionPlan = await buildVersionDeletionPlan({
        mediaType: 'episode',
        item: snapshot,
        selectedMediaIds: selectedIds,
        liveVersions,
        arrTargets: inspectedArrTargets,
        resolvedCleanup: acceptedCleanup,
        cleanupConfigured: acceptedCleanup !== null,
        allowEpisodeDownloadCleanup: true,
        excludedReassignMediaIds: excludedReassignIds,
        requiredMappingIdentities: inspectedMappings,
        episodeIdentity: {
          seasonNumber: snapshot.seasonIndex!,
          episodeNumber: snapshot.episodeIndex!,
        },
      });
      if (!inspectionPlan.arrOwnershipValid) {
        throw new Error(
          inspectionPlan.arrOwnershipReason ?? 'Sonarr ownership could not be re-inspected',
        );
      }
      if (!directCleanup) {
        const currentManagedSelectedMediaIds = inspectionPlan.arrManagedMediaIds.filter((mediaId) =>
          selectedIds.has(mediaId)
        ).sort((left, right) => left - right);
        if (
          JSON.stringify(currentManagedSelectedMediaIds) !==
            JSON.stringify(snapshot.seasonSonarrInspection!.managedSelectedMediaIds)
        ) {
          throw new Error('Sonarr ownership changed after Plex-only deletion was accepted');
        }
      }
    }
    if (snapshot.cleanupDownloads === true) {
      if (!inspectionPlan?.cleanup || !acceptedCleanup) {
        throw new Error(
          inspectionPlan?.preview.cleanupReason ??
            'the accepted qBittorrent payload no longer covers this season version',
        );
      }
      if (target.phase === 'validating') advancePhase(target, 'download_cleanup');
      await executeCleanup(
        target.serverId,
        new Map([[snapshot.ratingKey, inspectionPlan.cleanup]]),
        inspectionPlan.cleanup,
        snapshot.showRatingKey!,
        snapshot.seasonDownloadCleanup !== undefined,
      );
    }
    if (!(await directPlexDeletionStillSafe(target, snapshot, excludedReassignIds))) {
      throw new PlexReconciliationError(
        'at least one unselected live Plex version must remain',
        true,
        false,
      );
    }
    advancePhase(target, 'plex_reconciliation');
    await reconcilePlexTarget(target, snapshot);
    return;
  }

  if (snapshot.radarrRemovalFallback) {
    let cleanup: ResolvedCleanupItem | null = null;
    if (snapshot.cleanupDownloads) {
      const attemptRatingKey = snapshot.ratingKey;
      const downloadTargets = await getDownloadClientTargets(target.serverId);
      if (snapshot.radarrRemovalDownloadCleanup) {
        if (snapshot.radarrRemovalDownloadCleanup.ratingKey !== snapshot.ratingKey) {
          throw new Error('The durable download cleanup belongs to a different Plex item');
        }
        cleanup = rehydrateResolvedCleanup(
          snapshot.radarrRemovalDownloadCleanup,
          downloadTargets,
        );
      } else {
        const [arrTargets, attemptedJobs, attemptedOrphans] = await Promise.all([
          getArrDeleteTargets(target.serverId, snapshot.libraryKey),
          loadAttemptedDownloadJobKeysByItem(target.serverId, [attemptRatingKey]),
          loadAttemptedOrphanFilesByItem(target.serverId, [attemptRatingKey]),
        ]);
        cleanup = await resolveDownloadCleanup(
          snapshot.ratingKey,
          snapshot,
          arrTargets,
          downloadTargets,
          attemptedJobs.get(attemptRatingKey),
          attemptedOrphans.get(attemptRatingKey),
        );
        const selectedPath = normalizeRemoteAbsolute(
          snapshot.radarrRemovalFallback.selectedPlexPath,
        )?.comparison;
        cleanup = selectedPath
          ? selectVersionDownloadCleanup(cleanup, new Set([selectedPath]))
          : null;
        if (!cleanup) throw new Error('no verified downloaded-file cleanup is available');
        persistRadarrRemovalDownloadCleanup(target, snapshot, cleanup);
      }
    }
    if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');
    await coordinateRadarrRemovalFallback(target, snapshot, client);
    if (cleanup) {
      await assertVersionIsNotPlaying(client, snapshot.ratingKey);
      await coordinateRadarrRemovalFallback(target, snapshot, client);
      await executeCleanup(
        target.serverId,
        new Map([[snapshot.ratingKey, cleanup]]),
        cleanup,
        undefined,
        true,
      );
    }
    const after = await client.metadataIdentity(snapshot.ratingKey);
    if (
      !after ||
      !after.media.some(
        (entry) => entry.mediaId === snapshot.radarrRemovalFallback!.retainedMediaId,
      )
    ) {
      throw new Error('The retained Plex version disappeared after Radarr removal');
    }
    assertRadarrRemovalPlexVersions(
      await client.mediaVersionPathPreviews(snapshot.ratingKey),
      snapshot.radarrRemovalFallback,
      { allowSelectedAbsent: true },
    );
    await assertVersionIsNotPlaying(client, snapshot.ratingKey);
    advancePhase(target, 'plex_reconciliation');
    await reconcilePlexTarget(target, snapshot);
    return;
  }

  if (
    hasRemainingVersion && retainedMediaId === null &&
    snapshot.seasonCoordinationOutcome !== 'removed_and_unmonitored'
  ) {
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
            snapshot.seasonIndex !== null &&
            snapshot.seasonIndex !== undefined &&
            snapshot.episodeIndex !== null &&
            snapshot.episodeIndex !== undefined
          ? {
            episodeIdentity: {
              seasonNumber: snapshot.seasonIndex,
              episodeNumber: snapshot.episodeIndex,
            },
          }
          : {}),
      });
      assertAcceptedSeasonCoordination(snapshot, plan);
      if (!plan.arrOwnershipValid) {
        throw new Error(plan.arrOwnershipReason ?? 'Arr ownership could not be verified');
      }
      if (plan.arrManagedMediaIds.includes(snapshot.mediaId!)) {
        if (plan.preview.arrReassignStatus !== 'resolved') {
          throw new Error(
            plan.preview.arrReassignReason ?? 'The Arr-managed version cannot be safely reassigned',
          );
        }
        const candidateMediaId = snapshot.seasonSelectedCandidateMediaId ??
          bestLiveReassignmentCandidate(liveAtStart, plan.arrReassignCandidateMediaIds);
        if (candidateMediaId === null) {
          throw new Error('No deterministic retained Arr version is available');
        }
        if (!plan.arrReassignCandidateMediaIds.includes(candidateMediaId)) {
          throw new Error('The accepted retained Sonarr candidate is no longer eligible');
        }
        retainedMediaId = candidateMediaId;
      } else {
        persistArrOwnershipPlan(target.id, snapshot, plan);
      }
    }
  }

  if (snapshot.seasonCoordinationOutcome === 'removed_and_unmonitored') {
    await protectBreakGlassEpisode(target, snapshot);
    if (!snapshot.cleanupDownloads) {
      if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');
      await completeBreakGlassRemoval(target, snapshot);
      advancePhase(target, 'plex_reconciliation');
      await reconcilePlexTarget(target, snapshot);
      return;
    }
  }

  if (snapshot.cleanupDownloads || retainedMediaId !== null) {
    if (snapshot.cleanupDownloads && target.phase === 'validating') {
      advancePhase(target, 'download_cleanup');
    }
    const item: CoordinatedDeleteItem = snapshot;
    const cleanupItem: CoordinatedDeleteItem = target.targetKind === 'episode_version'
      ? { ...snapshot, ratingKey: snapshot.showRatingKey!, type: 'show' }
      : snapshot;
    const attemptRatingKey = target.targetKind === 'episode_version'
      ? snapshot.showRatingKey!
      : snapshot.ratingKey;
    const inspectDownloadCleanup = snapshot.cleanupDownloads === true;
    const [liveVersions, arrTargets, downloadTargets, attemptedJobs, attemptedOrphans] =
      await Promise.all([
        client.mediaVersionPathPreviews(snapshot.ratingKey),
        getArrDeleteTargets(target.serverId, snapshot.libraryKey),
        inspectDownloadCleanup ? getDownloadClientTargets(target.serverId) : Promise.resolve([]),
        inspectDownloadCleanup
          ? loadAttemptedDownloadJobKeysByItem(target.serverId, [attemptRatingKey])
          : Promise.resolve(new Map()),
        inspectDownloadCleanup
          ? loadAttemptedOrphanFilesByItem(target.serverId, [attemptRatingKey])
          : Promise.resolve(new Map()),
      ]);
    let resolvedCleanup: ResolvedCleanupItem | null = null;
    if (inspectDownloadCleanup) {
      if (snapshot.seasonDownloadCleanup) {
        if (snapshot.seasonDownloadCleanup.ratingKey !== attemptRatingKey) {
          throw new Error('The accepted season download cleanup belongs to another Plex show');
        }
        resolvedCleanup = rehydrateResolvedCleanup(
          snapshot.seasonDownloadCleanup,
          downloadTargets,
        );
      } else {
        resolvedCleanup = await resolveDownloadCleanup(
          attemptRatingKey,
          cleanupItem,
          arrTargets,
          downloadTargets,
          attemptedJobs.get(attemptRatingKey),
          attemptedOrphans.get(attemptRatingKey),
        );
      }
    }
    const attemptedArr = await loadAttemptedArrInstancesByItem(
      target.serverId,
      [{ ...snapshot, ratingKey: snapshot.ratingKey }],
      arrTargets.map((entry) => entry.instanceId),
    );
    let plan = await buildVersionDeletionPlan({
      mediaType: target.targetKind === 'movie_version' ? 'movie' : 'episode',
      item,
      selectedMediaIds: selectedIds,
      liveVersions,
      arrTargets,
      resolvedCleanup,
      cleanupConfigured: inspectDownloadCleanup && downloadTargets.length > 0,
      allowEpisodeDownloadCleanup: snapshot.seasonCleanup === true,
      attemptedArrInstanceIds: attemptedArr.get(snapshot.ratingKey),
      excludedReassignMediaIds: excludedReassignIds,
      requiredMappingIdentities: snapshot.arrReassignmentMappings,
      requiredReassignments: persistedArrReassignmentMap(snapshot),
      requiredOwnerships: persistedArrOwnershipMap(snapshot),
      serverId: target.serverId,
      libraryKey: snapshot.libraryKey,
      plexClient: client,
      versionRanks: liveAtStart.media,
      ...(snapshot.type === 'episode' &&
          snapshot.seasonIndex !== null &&
          snapshot.seasonIndex !== undefined &&
          snapshot.episodeIndex !== null &&
          snapshot.episodeIndex !== undefined
        ? {
          episodeIdentity: {
            seasonNumber: snapshot.seasonIndex,
            episodeNumber: snapshot.episodeIndex,
          },
        }
        : {}),
    });
    assertAcceptedSeasonCoordination(snapshot, plan);
    if (
      snapshot.cleanupDownloads &&
      (target.phase === 'validating' || target.phase === 'download_cleanup' ||
        target.phase === 'arr_coordination')
    ) {
      if (!plan.cleanup) {
        throw new Error(plan.preview.cleanupReason ?? 'cleanup could not be verified');
      }
      const protectedSeasonPayloadTargets = snapshot.seasonCleanup === true &&
          plan.cleanup.downloadJobs.length > 0
        ? await protectSeasonPayloadTargetsBeforeDownloadCleanup(target, snapshot, plan.cleanup)
        : [];
      if (retainedMediaId !== null && protectedSeasonPayloadTargets.length === 0) {
        await protectArrReassignmentBeforeDownloadCleanup(
          target,
          plan,
          snapshot,
          client,
          retainedMediaId,
        );
      }
      try {
        await assertVersionIsNotPlaying(client, snapshot.ratingKey);
        await executeCleanup(
          target.serverId,
          new Map([[snapshot.ratingKey, plan.cleanup]]),
          plan.cleanup,
          attemptRatingKey,
          snapshot.seasonDownloadCleanup !== undefined,
        );
      } catch (error) {
        if (
          !(await seasonCleanupHasAttemptEvidence(
            target.serverId,
            attemptRatingKey,
            plan.cleanup,
          ))
        ) {
          if (protectedSeasonPayloadTargets.length > 0) {
            await restoreSeasonPayloadProtectionAfterSafeDownloadFailure(
              protectedSeasonPayloadTargets,
            );
          } else if (retainedMediaId !== null) {
            await restoreArrReassignmentAfterSafeDownloadFailure(target, snapshot, client);
          } else if (snapshot.seasonCoordinationOutcome === 'removed_and_unmonitored') {
            await restoreBreakGlassMonitoringAfterSafeDownloadFailure(target, snapshot);
          }
        }
        throw error;
      }
      if (snapshot.seasonCoordinationOutcome === 'removed_and_unmonitored') {
        if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');
        await completeBreakGlassRemoval(target, snapshot);
        advancePhase(target, 'plex_reconciliation');
        await reconcilePlexTarget(target, snapshot);
        return;
      }
      if (retainedMediaId !== null) {
        const [freshVersions, freshArrTargets, freshIdentity] = await Promise.all([
          client.mediaVersionPathPreviews(snapshot.ratingKey),
          getArrDeleteTargets(target.serverId, snapshot.libraryKey),
          client.metadataIdentity(snapshot.ratingKey),
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
          serverId: target.serverId,
          libraryKey: snapshot.libraryKey,
          plexClient: client,
          versionRanks: freshIdentity?.media ?? [],
          ...(snapshot.type === 'episode' &&
              snapshot.seasonIndex !== null &&
              snapshot.seasonIndex !== undefined &&
              snapshot.episodeIndex !== null &&
              snapshot.episodeIndex !== undefined
            ? {
              episodeIdentity: {
                seasonNumber: snapshot.seasonIndex,
                episodeNumber: snapshot.episodeIndex,
              },
            }
            : {}),
        });
        assertAcceptedSeasonCoordination(snapshot, plan);
      }
    }
    if (retainedMediaId !== null) {
      if (target.phase !== 'arr_coordination') advancePhase(target, 'arr_coordination');
      if (plan.preview.arrReassignStatus !== 'resolved') {
        throw new Error(plan.preview.arrReassignReason ?? 'Arr reassignment could not be verified');
      }
      if (target.targetKind === 'movie_version') {
        await coordinateRadarrReassignment(target, snapshot, client, plan, retainedMediaId);
      } else {
        await waitForSonarrManagedPath(target, plan, snapshot, client, retainedMediaId);
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
        mediaType: target.targetKind === 'movie_version'
          ? ('movie' as const)
          : ('episode' as const),
        item: snapshot,
        selectedMediaIds: selectedIds,
        liveVersions,
        arrTargets,
        resolvedCleanup: null,
        cleanupConfigured: false,
        excludedReassignMediaIds: excludedReassignIds,
        requiredMappingIdentities: snapshot.arrReassignmentMappings,
        ...(snapshot.type === 'episode' &&
            snapshot.seasonIndex !== null &&
            snapshot.seasonIndex !== undefined &&
            snapshot.episodeIndex !== null &&
            snapshot.episodeIndex !== undefined
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
        if (snapshot.seasonCoordinationOutcome !== undefined) {
          throw new Error(
            finalPlan.arrOwnershipReason ?? 'The accepted Sonarr ownership changed',
          );
        }
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
      assertAcceptedSeasonCoordination(snapshot, finalPlan);
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
          await coordinateRadarrReassignment(target, snapshot, client, finalPlan, candidateMediaId);
        } else {
          await waitForSonarrManagedPath(target, finalPlan, snapshot, client, candidateMediaId);
          confirmReassignedRemoval(target);
          await reconcileArrReassignmentFinalState(target, snapshot, client);
          await reconcilePlexTarget(target, snapshot);
        }
        return;
      }
    }
    if (!(await directPlexDeletionStillSafe(target, snapshot, excludedReassignIds))) {
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
      if (snapshot.type === 'season') {
        await assertWholeSeasonSonarrPostcondition(target, snapshot, false);
      }
      if ((snapshot.arrReassignments?.length ?? 0) > 0) {
        const validation = await validateDeletionTarget(target.serverId, target);
        await reconcileArrReassignmentFinalState(target, snapshot, validation.client);
      }
      await reconcilePlexTarget(target, snapshot);
      return;
    }
    if (await tryRecoverRadarrWithoutSelectedProjection(target, snapshot)) return;
    const validation = await validateDeletionTarget(target.serverId, target);
    if (target.targetKind === 'whole_item') {
      if (validation.snapshot.type === 'season') {
        await ensureWholeSeasonDeleted(
          target,
          validation.snapshot,
          validation.client,
          validation.live,
        );
      } else {
        await ensureWholeItemDeleted(
          target,
          validation.snapshot,
          validation.client,
          validation.live,
        );
      }
    } else {
      await ensureVersionDeleted(target, validation.snapshot, validation.client, validation.live);
    }
  } finally {
    release();
  }
}
