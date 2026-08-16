// Coordinates the existing whole-series rescan boundary across active season targets.
import { withTransaction } from '../../../db/index.ts';
import type { SonarrSeriesSnapshot } from '../../../integrations/arr/client.ts';
import { getArrDeleteTargets } from '../../arr/delete.ts';
import type { PersistedArrReassignment } from '../../mediaDeletion/arrReassignmentPlanning/types.ts';
import {
  buildVersionDeletionPlan,
  type VersionDeletionPlan,
} from '../../mediaDeletion/versionPlanning.ts';
import { DeletionConvergenceError, type DeletionWorkTarget } from '../core/types.ts';
import { type DurableTargetSnapshot, validateDeletionTarget } from '../core/validation.ts';
import {
  assertVersionIsNotPlaying,
  bestLiveReassignmentCandidate,
  ensureArrMonitoringEvidence,
  ensureArrReassignmentProtected,
  persistArrReassignmentPlan,
  persistedArrOwnershipMap,
  restoreArrReassignmentAfterSafeDownloadFailure,
  restoreArrReassignmentMonitoring,
} from './arrReassignment.ts';
import {
  findAuthorizedSonarrCandidate,
  sonarrInventoryHasOnlyAuthorizedCandidates,
  type SonarrRescanAuthorizedChange,
  sonarrRescanHasOnlyAuthorizedChanges,
} from './sonarrSnapshotPolicy.ts';
import { persistSonarrTransition } from './sonarrTransitionStore.ts';

const ARR_CONVERGENCE_MAX_ATTEMPTS = 15;
const ARR_CONVERGENCE_POLL_INTERVAL_MS = 1_000;

export interface SonarrAdoptedCandidate {
  candidate: NonNullable<
    PersistedArrReassignment['sonarrTransition']
  >['candidateAllowlist'][number];
  state: SonarrSeriesSnapshot;
  fileId: number;
}

interface ProtectedSonarrRescanTarget {
  target: DeletionWorkTarget;
  snapshot: DurableTargetSnapshot;
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'];
  persisted: PersistedArrReassignment;
}

function activeSeasonAdoptionTargets(operationId: string): DeletionWorkTarget[] {
  return withTransaction((client) =>
    client.prepare(
      `SELECT t.id, t.operation_id, o.server_id, t.target_kind, t.target_key, t.snapshot,
              t.logical_size, t.phase, t.removal_confirmed_at, t.plex_attempt_count
       FROM deletion_targets t
       JOIN deletion_operations o ON o.id = t.operation_id
       WHERE t.operation_id = ? AND t.status IN ('queued', 'running')
         AND json_extract(t.snapshot, '$.seasonCoordinationOutcome') = 'automatic_adoption'
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

async function protectSonarrRescanOperation(
  owner: DeletionWorkTarget,
  ownerSnapshot: DurableTargetSnapshot,
  ownerClient: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  instanceId: number,
  seriesId: number,
): Promise<ProtectedSonarrRescanTarget[]> {
  const protectedTargets: ProtectedSonarrRescanTarget[] = [];
  try {
    const operationTargets = activeSeasonAdoptionTargets(owner.operationId);
    if (!operationTargets.some((candidate) => candidate.id === owner.id)) {
      operationTargets.unshift(owner);
    }
    for (const candidateTarget of operationTargets) {
      const snapshot = candidateTarget.id === owner.id
        ? ownerSnapshot
        : JSON.parse(candidateTarget.snapshot) as DurableTargetSnapshot;
      if (
        snapshot.seasonRatingKey !== ownerSnapshot.seasonRatingKey ||
        snapshot.seasonSonarrVersion !== ownerSnapshot.seasonSonarrVersion
      ) throw new Error('The durable season-wide Sonarr authorization is inconsistent');
      const validation = candidateTarget.id === owner.id
        ? { client: ownerClient, live: await ownerClient.metadataIdentity(snapshot.ratingKey) }
        : await validateDeletionTarget(candidateTarget.serverId, candidateTarget);
      if (!validation.live) throw new Error('A season-wide Sonarr target disappeared from Plex');
      await assertVersionIsNotPlaying(validation.client, snapshot.ratingKey);
      if ((snapshot.arrReassignments?.length ?? 0) === 0) {
        const selectedIds = new Set(snapshot.selectedMediaIds ?? [snapshot.mediaId!]);
        const excludedIds = new Set(snapshot.operationMediaIds ?? [...selectedIds]);
        const [liveVersions, arrTargets] = await Promise.all([
          validation.client.mediaVersionPathPreviews(snapshot.ratingKey),
          getArrDeleteTargets(candidateTarget.serverId, snapshot.libraryKey),
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
          requiredOwnerships: persistedArrOwnershipMap(snapshot),
          serverId: candidateTarget.serverId,
          libraryKey: snapshot.libraryKey,
          plexClient: validation.client,
          versionRanks: validation.live.media,
          episodeIdentity: {
            seasonNumber: snapshot.seasonIndex!,
            episodeNumber: snapshot.episodeIndex!,
          },
        });
        const retainedMediaId = snapshot.seasonSelectedCandidateMediaId ??
          bestLiveReassignmentCandidate(validation.live, plan.arrReassignCandidateMediaIds);
        if (
          !plan.arrOwnershipValid || plan.preview.arrReassignStatus !== 'resolved' ||
          retainedMediaId === null || !plan.arrReassignCandidateMediaIds.includes(retainedMediaId)
        ) throw new Error('A season-wide Sonarr target no longer has an authorized candidate');
        persistArrReassignmentPlan(candidateTarget.id, snapshot, plan, retainedMediaId);
        candidateTarget.snapshot = JSON.stringify(snapshot);
      }
      const persisted = snapshot.arrReassignments?.find((entry) =>
        entry.instanceType === 'sonarr' && entry.instanceId === instanceId &&
        entry.recordId === seriesId
      );
      if (!persisted?.sonarrTransition || persisted.episodeId === null) {
        throw new Error('The durable season-wide Sonarr reassignment is incomplete');
      }
      await ensureArrMonitoringEvidence(candidateTarget, snapshot, validation.client);
      await ensureArrReassignmentProtected(
        candidateTarget,
        snapshot,
        validation.client,
        persisted,
      );
      candidateTarget.snapshot = JSON.stringify(snapshot);
      protectedTargets.push({
        target: candidateTarget,
        snapshot,
        client: validation.client,
        persisted,
      });
    }
  } catch (error) {
    for (const entry of protectedTargets) {
      if (entry.target.id === owner.id) continue;
      await restoreArrReassignmentAfterSafeDownloadFailure(
        entry.target,
        entry.snapshot,
        entry.client,
      ).catch(() => undefined);
    }
    throw error;
  }
  return protectedTargets;
}

function rescanAuthorizedChanges(
  before: import('../../../integrations/arr/client.ts').SonarrSeriesSnapshot,
  targets: readonly ProtectedSonarrRescanTarget[],
  ownerId: number,
): SonarrRescanAuthorizedChange[] {
  return targets.map(({ target, persisted }) => {
    const episode = before.episodes.find((entry) => entry.id === persisted.episodeId);
    if (!episode || persisted.episodeId === null) {
      throw new Error('The Sonarr rescan snapshot lost an authorized episode');
    }
    return {
      targetId: target.id,
      episodeId: persisted.episodeId,
      oldFileId: episode.episodeFileId,
      ...(target.id === ownerId ? {} : { restoredMonitored: persisted.originalMonitored }),
      candidates: persisted.sonarrTransition!.candidateAllowlist.map((entry) => ({ ...entry })),
    };
  }).sort((left, right) => left.targetId - right.targetId);
}

async function reconcileProtectedRescanTargets(
  ownerId: number,
  state: import('../../../integrations/arr/client.ts').SonarrSeriesSnapshot,
  targets: readonly ProtectedSonarrRescanTarget[],
): Promise<void> {
  for (const context of targets) {
    if (context.target.id === ownerId) continue;
    const episode = state.episodes.find((entry) => entry.id === context.persisted.episodeId);
    const file = episode?.episodeFileId
      ? state.files.find((entry) => entry.id === episode.episodeFileId)
      : null;
    if (file && file.id !== context.persisted.managedFileId) {
      const adopted = findAuthorizedSonarrCandidate(
        file,
        context.persisted.sonarrTransition!.candidateAllowlist,
      );
      if (!adopted) {
        throw new DeletionConvergenceError(
          'Sonarr rescan adopted an unauthorized sibling season file',
        );
      }
      persistSonarrTransition(
        context.target,
        context.snapshot,
        context.persisted.instanceId,
        (entry) => {
          entry.retainedMediaId = adopted.mediaId;
          entry.retainedPath = adopted.path;
          entry.retainedFileSize = adopted.size;
          entry.sonarrTransition!.adoptedMediaId = adopted.mediaId;
        },
      );
      context.persisted.retainedMediaId = adopted.mediaId;
      context.persisted.retainedPath = adopted.path;
      context.persisted.retainedFileSize = adopted.size;
      context.persisted.sonarrTransition!.adoptedMediaId = adopted.mediaId;
      await restoreArrReassignmentMonitoring(
        context.target,
        context.snapshot,
        context.client,
        context.persisted,
      );
    } else {
      await restoreArrReassignmentAfterSafeDownloadFailure(
        context.target,
        context.snapshot,
        context.client,
      );
    }
  }
}

function assertNoRescanCollateral(
  before: SonarrSeriesSnapshot,
  after: SonarrSeriesSnapshot,
  authorized: readonly SonarrRescanAuthorizedChange[],
): void {
  if (!sonarrRescanHasOnlyAuthorizedChanges(before, after, authorized)) {
    throw new DeletionConvergenceError(
      'Sonarr rescan caused collateral series mutations; monitoring remains protected',
    );
  }
}

export async function reconcileAttemptedSonarrRescan(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  persisted: PersistedArrReassignment,
  adoptedState: SonarrSeriesSnapshot,
): Promise<void> {
  const transition = persisted.sonarrTransition!;
  if (
    !transition.rescanPreSnapshot || !transition.rescanInventory ||
    !transition.rescanAuthorizedChanges
  ) {
    throw new DeletionConvergenceError(
      'The durable Sonarr rescan authorization is incomplete; monitoring remains protected',
    );
  }
  const protectedTargets = await protectSonarrRescanOperation(
    target,
    snapshot,
    client,
    persisted.instanceId,
    persisted.recordId,
  );
  assertNoRescanCollateral(
    transition.rescanPreSnapshot,
    adoptedState,
    transition.rescanAuthorizedChanges,
  );
  await reconcileProtectedRescanTargets(target.id, adoptedState, protectedTargets);
}

export async function runGuardedSonarrRescanFallback(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  persisted: PersistedArrReassignment,
  entry: VersionDeletionPlan['eligibleArrReassignments'][number],
  adoptedCandidate: () => Promise<SonarrAdoptedCandidate | null>,
): Promise<SonarrAdoptedCandidate | null> {
  const transition = persisted.sonarrTransition!;
  let adopted: SonarrAdoptedCandidate | null = null;
  const commandId = persisted.sonarrTransition!.manualImportCommandId;
  if (
    commandId === undefined &&
    persisted.sonarrTransition!.manualImportRejectedAt === undefined
  ) {
    throw new DeletionConvergenceError(
      'Sonarr Manual Import acceptance is ambiguous; the episode remains unmonitored',
    );
  }
  const command = commandId === undefined
    ? null
    : await entry.target.client.sonarrCommand(commandId);
  const terminal = commandId === undefined || command === null ||
    ['completed', 'failed', 'aborted', 'cancelled'].includes(command.status);
  const activity = await entry.target.client.sonarrSeriesActivity(
    persisted.recordId,
    commandId === undefined ? [] : [commandId],
  );
  if (!terminal || !activity.quiet) {
    throw new DeletionConvergenceError(
      'Sonarr Manual Import is not provably quiescent; rescan was withheld',
    );
  }
  let before = transition.rescanPreSnapshot;
  let inventory = transition.rescanInventory;
  const protectedTargets = await protectSonarrRescanOperation(
    target,
    snapshot,
    client,
    persisted.instanceId,
    persisted.recordId,
  );
  if (!before || !inventory) {
    before = await entry.target.client.sonarrSeriesSnapshot(persisted.recordId);
    inventory = await entry.target.client.sonarrManualImportInventory(
      persisted.recordId,
      persisted.recordPath,
    );
  }
  const authorized = rescanAuthorizedChanges(before, protectedTargets, target.id);
  if (!sonarrInventoryHasOnlyAuthorizedCandidates(inventory, authorized)) {
    throw new DeletionConvergenceError(
      'Sonarr series rescan was withheld because unrelated or unauthorized work is visible',
    );
  }
  for (const file of before.files) {
    if (await entry.target.client.fileVisibility(file.path) !== 'file') {
      throw new DeletionConvergenceError(
        'Sonarr series rescan was withheld because a managed file is not visible',
      );
    }
  }
  for (const change of authorized) {
    for (const candidate of change.candidates) {
      if (await entry.target.client.fileVisibility(candidate.path) !== 'file') {
        throw new DeletionConvergenceError(
          'Sonarr series rescan was withheld because an authorized retained file is not visible',
        );
      }
    }
  }
  if (persisted.sonarrTransition!.rescanAttemptedAt === undefined) {
    persistSonarrTransition(target, snapshot, persisted.instanceId, (next) => {
      next.sonarrTransition!.rescanAuthorizedAt = Math.floor(Date.now() / 1000);
      next.sonarrTransition!.rescanPreSnapshot = before;
      next.sonarrTransition!.rescanInventory = inventory;
      next.sonarrTransition!.rescanAuthorizedChanges = authorized;
      next.sonarrTransition!.rescanAttemptedAt = Math.floor(Date.now() / 1000);
    });
    persisted.sonarrTransition!.rescanPreSnapshot = before;
    persisted.sonarrTransition!.rescanInventory = inventory;
    persisted.sonarrTransition!.rescanAuthorizedChanges = authorized;
    persisted.sonarrTransition!.rescanAttemptedAt = Math.floor(Date.now() / 1000);
    try {
      const rescan = await entry.target.client.sonarrRescanSeries(persisted.recordId);
      persistSonarrTransition(target, snapshot, persisted.instanceId, (next) => {
        next.sonarrTransition!.rescanCommandId = rescan.id;
      });
      persisted.sonarrTransition!.rescanCommandId = rescan.id;
    } catch {
      // Reconcile the exact complete series state after an ambiguous response.
    }
  }
  for (let attempt = 0; !adopted && attempt < ARR_CONVERGENCE_MAX_ATTEMPTS; attempt++) {
    adopted = await adoptedCandidate();
    if (!adopted) {
      await new Promise((resolve) => setTimeout(resolve, ARR_CONVERGENCE_POLL_INTERVAL_MS));
    }
  }
  let rescanQuiescent = false;
  for (let attempt = 0; attempt < ARR_CONVERGENCE_MAX_ATTEMPTS; attempt++) {
    const commandId = persisted.sonarrTransition!.rescanCommandId;
    const command = commandId === undefined
      ? null
      : await entry.target.client.sonarrCommand(commandId);
    const terminal = commandId === undefined
      ? false
      : command === null || ['completed', 'failed', 'aborted', 'cancelled'].includes(
        command.status,
      );
    const activity = await entry.target.client.sonarrSeriesActivity(
      persisted.recordId,
      commandId === undefined ? [] : [commandId],
    );
    if ((terminal || commandId === undefined && activity.quiet) && activity.quiet) {
      rescanQuiescent = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, ARR_CONVERGENCE_POLL_INTERVAL_MS));
  }
  if (!rescanQuiescent) {
    throw new DeletionConvergenceError(
      'Sonarr rescan completion is ambiguous; monitoring remains protected',
    );
  }
  const finalState = await entry.target.client.sonarrSeriesSnapshot(persisted.recordId);
  assertNoRescanCollateral(before, finalState, authorized);
  await reconcileProtectedRescanTargets(target.id, finalState, protectedTargets);
  adopted = await adoptedCandidate();
  return adopted;
}
