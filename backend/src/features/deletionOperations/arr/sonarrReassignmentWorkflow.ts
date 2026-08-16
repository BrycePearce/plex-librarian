// Runs the existing per-target Sonarr removal, adoption, and monitoring workflow.
import { ArrApiError } from '../../../integrations/arr/client.ts';
import type { PersistedArrReassignment } from '../../mediaDeletion/arrReassignmentPlanning/types.ts';
import type { VersionDeletionPlan } from '../../mediaDeletion/versionPlanning.ts';
import { DeletionConvergenceError, type DeletionWorkTarget } from '../core/types.ts';
import { type DurableTargetSnapshot, validateDeletionTarget } from '../core/validation.ts';
import {
  ensureArrMonitoringEvidence,
  ensureArrReassignmentProtected,
  oldManagedFileIsPresent,
  persistArrReassignmentPlan,
  restoreArrReassignmentMonitoring,
  retainedFileIsAdopted,
  revalidateArrReassignment,
} from './arrReassignment.ts';
import {
  reconcileAttemptedSonarrRescan,
  runGuardedSonarrRescanFallback,
  type SonarrAdoptedCandidate,
} from './sonarrRescanCoordinator.ts';
import { findAuthorizedSonarrCandidate } from './sonarrSnapshotPolicy.ts';
import { persistSonarrTransition } from './sonarrTransitionStore.ts';

const ARR_CONVERGENCE_MAX_ATTEMPTS = 15;
const ARR_CONVERGENCE_POLL_INTERVAL_MS = 1_000;

type PlexClient = Awaited<ReturnType<typeof validateDeletionTarget>>['client'];
type ArrReassignmentEntry = VersionDeletionPlan['eligibleArrReassignments'][number];
type SonarrCandidate = NonNullable<
  PersistedArrReassignment['sonarrTransition']
>['candidateAllowlist'][number];

async function reconcileOrRemoveOldManagedFile(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: PlexClient,
  persisted: PersistedArrReassignment,
  entry: ArrReassignmentEntry,
): Promise<ArrReassignmentEntry> {
  if (entry.alreadyReassigned || entry.managedFileId === null) return entry;
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
  return entry;
}

async function confirmOldManagedFileRemoval(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: PlexClient,
  persisted: PersistedArrReassignment,
): Promise<ArrReassignmentEntry> {
  const entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
  if (oldManagedFileIsPresent(entry, persisted)) {
    throw new DeletionConvergenceError(`${entry.target.instanceName} still reports the old file`);
  }
  if (await entry.target.client.fileVisibility(persisted.managedPath) !== 'missing') {
    throw new DeletionConvergenceError(
      `${entry.target.instanceName} detached the old EpisodeFile but its path is still present`,
    );
  }
  const transition = persisted.sonarrTransition;
  if (!transition || persisted.episodeId === null) {
    throw new Error('The durable Sonarr adoption plan is incomplete');
  }
  if (transition.oldFileRemovalConfirmedAt === undefined) {
    const confirmedAt = Math.floor(Date.now() / 1000);
    persistSonarrTransition(target, snapshot, persisted.instanceId, (next) => {
      next.sonarrTransition!.oldFileRemovalConfirmedAt = confirmedAt;
    });
    persisted.sonarrTransition!.oldFileRemovalConfirmedAt = confirmedAt;
  }
  if (transition.candidateAllowlist.length === 0) {
    throw new Error('The Sonarr adoption allowlist is empty');
  }
  return entry;
}

async function readAdoptedCandidate(
  entry: ArrReassignmentEntry,
  persisted: PersistedArrReassignment,
  allowlist: readonly SonarrCandidate[],
): Promise<SonarrAdoptedCandidate | null> {
  const state = await entry.target.client.sonarrSeriesSnapshot(persisted.recordId);
  const episode = state.episodes.find((candidate) => candidate.id === persisted.episodeId);
  if (!episode) throw new Error('The Sonarr episode identity disappeared during adoption');
  if (episode.episodeFileId === 0) return null;
  const file = state.files.find((candidate) => candidate.id === episode.episodeFileId);
  if (
    !file || file.id === persisted.managedFileId || file.episodeIds.length !== 1 ||
    file.episodeIds[0] !== persisted.episodeId
  ) {
    throw new Error('Sonarr adopted an unauthorized or malformed EpisodeFile');
  }
  const candidate = findAuthorizedSonarrCandidate(file, allowlist);
  if (!candidate) {
    throw new Error('Sonarr adopted a path outside the authorized retained-version allowlist');
  }
  if (await entry.target.client.fileVisibility(candidate.path) !== 'file') {
    throw new Error('The adopted retained Sonarr file is not visible');
  }
  return { candidate, state, fileId: file.id };
}

async function attemptManualImport(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  persisted: PersistedArrReassignment,
  entry: ArrReassignmentEntry,
  desiredPath: string,
): Promise<void> {
  const [fresh] = await entry.target.client.sonarrManualImportPreflight([{
    path: desiredPath,
    seriesId: persisted.recordId,
    seasonNumber: snapshot.seasonIndex!,
    episodeIds: [persisted.episodeId!],
  }]);
  if (
    !fresh || fresh.path !== desiredPath || fresh.size !== persisted.retainedFileSize ||
    fresh.seriesId !== persisted.recordId || fresh.episodeIds.length !== 1 ||
    fresh.episodeIds[0] !== persisted.episodeId || fresh.rejectionReasons.length > 0
  ) throw new Error('Fresh Sonarr Manual Import preflight did not match the durable target');
  persistSonarrTransition(target, snapshot, persisted.instanceId, (next) => {
    next.sonarrTransition!.postDeletionPreflight = fresh;
    next.sonarrTransition!.manualImportAttemptedAt = Math.floor(Date.now() / 1000);
  });
  persisted.sonarrTransition!.postDeletionPreflight = fresh;
  persisted.sonarrTransition!.manualImportAttemptedAt = Math.floor(Date.now() / 1000);
  try {
    const command = await entry.target.client.sonarrManualImport(fresh);
    persistSonarrTransition(target, snapshot, persisted.instanceId, (next) => {
      next.sonarrTransition!.manualImportCommandId = command.id;
    });
    persisted.sonarrTransition!.manualImportCommandId = command.id;
  } catch (error) {
    // A response carrying an HTTP status proves that Sonarr rejected this
    // submission. Transport failures remain ambiguous because the command may
    // have been accepted before the connection was lost.
    if (error instanceof ArrApiError && error.status !== undefined) {
      const rejectedAt = Math.floor(Date.now() / 1000);
      persistSonarrTransition(target, snapshot, persisted.instanceId, (next) => {
        next.sonarrTransition!.manualImportRejectedAt = rejectedAt;
      });
      persisted.sonarrTransition!.manualImportRejectedAt = rejectedAt;
    }
  }
}

async function pollForAdoption(
  adoptedCandidate: () => Promise<SonarrAdoptedCandidate | null>,
): Promise<SonarrAdoptedCandidate | null> {
  let adopted: SonarrAdoptedCandidate | null = null;
  for (let attempt = 0; !adopted && attempt < ARR_CONVERGENCE_MAX_ATTEMPTS; attempt++) {
    adopted = await adoptedCandidate();
    if (!adopted) {
      await new Promise((resolve) => setTimeout(resolve, ARR_CONVERGENCE_POLL_INTERVAL_MS));
    }
  }
  return adopted;
}

function persistAdoption(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  persisted: PersistedArrReassignment,
  candidate: SonarrCandidate,
): void {
  persistSonarrTransition(target, snapshot, persisted.instanceId, (next) => {
    next.retainedMediaId = candidate.mediaId;
    next.retainedPath = candidate.path;
    next.retainedFileSize = candidate.size;
    next.sonarrTransition!.adoptedMediaId = candidate.mediaId;
  });
  persisted.retainedMediaId = candidate.mediaId;
  persisted.retainedPath = candidate.path;
  persisted.retainedFileSize = candidate.size;
  persisted.sonarrTransition!.adoptedMediaId = candidate.mediaId;
}

export async function waitForSonarrManagedPath(
  target: DeletionWorkTarget,
  plan: VersionDeletionPlan | null,
  snapshot: DurableTargetSnapshot,
  client: PlexClient,
  retainMediaId: number,
): Promise<void> {
  if ((snapshot.arrReassignments?.length ?? 0) === 0) {
    if (!plan) throw new Error('The durable Sonarr reassignment plan is incomplete');
    persistArrReassignmentPlan(target.id, snapshot, plan, retainMediaId);
  }
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
    entry = await reconcileOrRemoveOldManagedFile(target, snapshot, client, persisted, entry);
    entry = await confirmOldManagedFileRemoval(target, snapshot, client, persisted);
    const transition = persisted.sonarrTransition!;
    const adoptedCandidate = () =>
      readAdoptedCandidate(entry, persisted, transition.candidateAllowlist);

    let adopted = await adoptedCandidate();
    if (adopted && transition.rescanAttemptedAt !== undefined) {
      await reconcileAttemptedSonarrRescan(
        target,
        snapshot,
        client,
        persisted,
        adopted.state,
      );
    }
    if (!adopted && transition.manualImportAttemptedAt === undefined) {
      await attemptManualImport(target, snapshot, persisted, entry, desiredPath);
    }
    if (!adopted) adopted = await pollForAdoption(adoptedCandidate);
    if (!adopted) {
      adopted = await runGuardedSonarrRescanFallback(
        target,
        snapshot,
        client,
        persisted,
        entry,
        adoptedCandidate,
      );
    }
    if (!adopted) {
      throw new DeletionConvergenceError(
        `${entry.target.instanceName} did not adopt an authorized retained Plex version; the episode remains intentionally unmonitored`,
      );
    }
    persistAdoption(target, snapshot, persisted, adopted.candidate);
    await restoreArrReassignmentMonitoring(target, snapshot, client, persisted);
  }
}
