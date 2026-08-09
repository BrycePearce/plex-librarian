// Retained-version reassignment only; Radarr removal fallback is coordinated separately.
import { buildVersionDeletionPlan } from '../../mediaDeletion/versionPlanning.ts';
import {
  ensureArrMonitoringEvidence,
  ensureArrReassignmentProtected,
  persistArrReassignmentPlan,
  radarrReassignmentAlreadyAdopted,
  reconcileArrReassignmentFinalState,
  waitForRadarrManagedPath,
} from './arrReassignment.ts';
import {
  advancePhase,
  confirmRadarrPlexRemoval,
  radarrLegacyAccountingIsAmbiguous,
} from '../core/deletionState.ts';
import {
  assertActivePlexIdentity,
  assertRetainedVersionPostcondition,
  deleteExactPlexTarget,
  reconcilePlexTarget,
} from '../workflow/plexReconciliation.ts';
import type { DeletionWorkTarget } from '../core/types.ts';
import {
  type DurableTargetSnapshot,
  validateDeletionTarget,
  validateLiveDeletionIdentity,
} from '../core/validation.ts';
import { withTransaction } from '../../../db/index.ts';
import { normalizeRemoteAbsolute } from '../../mediaDeletion/hardlinks.ts';
import { radarrBytesMatchProjectedKilobytes } from '../../mediaDeletion/radarrSize.ts';
import type { PersistedArrReassignment } from '../../mediaDeletion/arrReassignmentPlanning/types.ts';
import { DeletionConvergenceError } from '../core/types.ts';

function samePath(left: string | null, right: string): boolean {
  return (
    left !== null &&
    normalizeRemoteAbsolute(left)?.comparison === normalizeRemoteAbsolute(right)?.comparison
  );
}

function persistPathProgress(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  instanceId: number,
  update: (entry: PersistedArrReassignment) => void,
): void {
  const before = JSON.stringify(snapshot);
  const next = structuredClone(snapshot);
  const entry = next.arrReassignments?.find((candidate) => candidate.instanceId === instanceId);
  if (!entry?.radarrPathPlan) throw new Error('The durable Radarr path plan is missing');
  update(entry);
  const now = Math.floor(Date.now() / 1000);
  const changed = withTransaction((client) =>
    client
      .prepare(
        "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running' AND snapshot = ?",
      )
      .run(JSON.stringify(next), now, target.id, before)
  );
  if (changed !== 1) throw new DeletionConvergenceError('Could not persist Radarr path progress');
  snapshot.arrReassignments = next.arrReassignments;
  target.snapshot = JSON.stringify(next);
}

async function adoptRadarrPathBeforePlexDeletion(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  persisted: PersistedArrReassignment,
): Promise<void> {
  const pathPlan = persisted.radarrPathPlan;
  if (!pathPlan || pathPlan.mode === 'existing_path') return;
  if (!pathPlan.planFingerprint) throw new Error('The Radarr path plan fingerprint is missing');
  if (
    pathPlan.mode === 'adopt_path_with_consent' && pathPlan.userAuthorizedPathManagement !== true
  ) {
    throw new Error('Radarr retained-path management was not authorized');
  }

  let entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
  if (
    !samePath(entry.recordPath, pathPlan.originalMoviePath) &&
    !samePath(entry.recordPath, pathPlan.targetMoviePath)
  ) {
    throw new Error(`Radarr Movie.Path changed to an unexpected third path: ${entry.recordPath}`);
  }
  const adopted = () =>
    samePath(entry.recordPath, pathPlan.targetMoviePath) &&
    samePath(entry.managedPath, pathPlan.retainedPath) &&
    entry.managedFileId !== null &&
    entry.managedFileId !== pathPlan.originalMovieFile.id &&
    radarrBytesMatchProjectedKilobytes(entry.managedFileSize, persisted.retainedFileSize);
  if (!adopted() && samePath(entry.recordPath, pathPlan.originalMoviePath)) {
    entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
    const now = Math.floor(Date.now() / 1000);
    persistPathProgress(target, snapshot, persisted.instanceId, (current) => {
      current.radarrPathPlan!.transition = {
        ...current.radarrPathPlan!.transition,
        pathUpdateAttemptedAt: now,
      };
    });
    await entry.target.client.updateRadarrMoviePath(
      {
        movieId: pathPlan.movieId,
        tmdbId: snapshot.tmdbId!,
        path: pathPlan.originalMoviePath,
      },
      pathPlan.targetMoviePath,
    );
    persistPathProgress(target, snapshot, persisted.instanceId, (current) => {
      current.radarrPathPlan!.transition = {
        ...current.radarrPathPlan!.transition,
        pathConfirmedAt: Math.floor(Date.now() / 1000),
      };
    });
    entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
  }
  if (!samePath(entry.recordPath, pathPlan.targetMoviePath)) {
    throw new Error('Radarr Movie.Path did not converge to the retained parent');
  }
  if (adopted()) return;

  const transition = persisted.radarrPathPlan?.transition;
  let commandId = transition?.rescanCommandId;
  if (commandId !== undefined) {
    const command = await entry.target.client.radarrCommand(commandId);
    if (!['completed', 'failed', 'aborted'].includes(command.status)) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
        if (adopted()) break;
        const current = await entry.target.client.radarrCommand(commandId);
        if (['completed', 'failed', 'aborted'].includes(current.status)) break;
      }
    }
  } else {
    const attemptedAt = transition?.rescanAttemptedAt;
    if (attemptedAt && Math.floor(Date.now() / 1000) - attemptedAt < 10) {
      throw new DeletionConvergenceError(
        'Radarr rescan acceptance is ambiguous; waiting for the bounded quiescence interval',
      );
    }
    entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
    persistPathProgress(target, snapshot, persisted.instanceId, (current) => {
      current.radarrPathPlan!.transition = {
        ...current.radarrPathPlan!.transition,
        rescanAttemptedAt: Math.floor(Date.now() / 1000),
      };
    });
    try {
      const command = await entry.target.client.startRadarrRescan(pathPlan.movieId);
      commandId = command.id;
      persistPathProgress(target, snapshot, persisted.instanceId, (current) => {
        current.radarrPathPlan!.transition = {
          ...current.radarrPathPlan!.transition,
          rescanCommandId: command.id,
          rescanCommandStatus: command.status,
        };
      });
    } catch (error) {
      entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
      if (!adopted()) throw error;
    }
  }

  for (let attempt = 0; attempt < 30 && !adopted(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
  }
  if (!adopted()) {
    throw new DeletionConvergenceError(
      'Radarr did not adopt the exact retained file under a new movie-file ID; both Plex files remain intact and monitoring remains off',
    );
  }
  persistPathProgress(target, snapshot, persisted.instanceId, (current) => {
    current.radarrPathPlan!.adoptedMovieFile = {
      id: entry.managedFileId!,
      path: entry.managedPath!,
      relativePath: entry.managedPath!.replaceAll('\\', '/').split('/').at(-1)!,
      size: entry.managedFileSize!,
    };
    current.radarrPathPlan!.transition = {
      ...current.radarrPathPlan!.transition,
      adoptedAt: Math.floor(Date.now() / 1000),
    };
  });
}

export async function coordinateRadarrReassignment(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
  plan?: Awaited<ReturnType<typeof buildVersionDeletionPlan>>,
  retainMediaId?: number,
): Promise<void> {
  if (plan && retainMediaId !== undefined) {
    persistArrReassignmentPlan(target.id, snapshot, plan, retainMediaId);
  }
  if (
    !snapshot.arrReassignments?.length ||
    snapshot.arrReassignments.some((entry) => entry.instanceType !== 'radarr')
  ) {
    throw new Error('The persisted Radarr reassignment plan is incomplete');
  }
  await ensureArrMonitoringEvidence(target, snapshot, client);

  const plexClient = await assertActivePlexIdentity(target, snapshot);
  let live = await plexClient.metadataIdentity(snapshot.ratingKey);
  if (!live) throw new Error('The retained Plex item disappeared during Arr reassignment');
  await validateLiveDeletionIdentity(plexClient, target.targetKind, snapshot, live);
  assertRetainedVersionPostcondition(target, snapshot, live);
  const selectedPresent = live.media.some((entry) => entry.mediaId === snapshot.mediaId);

  for (const persisted of snapshot.arrReassignments) {
    await adoptRadarrPathBeforePlexDeletion(target, snapshot, client, persisted);
  }

  if (selectedPresent) {
    for (const persisted of snapshot.arrReassignments) {
      let entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
      // Revalidate the complete destructive boundary after monitoring protection
      // has converged and immediately before the Plex-first mutation.
      entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
      const outsideAdopted = persisted.radarrPathPlan &&
        persisted.radarrPathPlan.mode !== 'existing_path';
      if (
        entry.managedPath === null ||
        (!outsideAdopted && entry.managedFileId !== persisted.managedFileId) ||
        (outsideAdopted &&
          entry.managedFileId === persisted.radarrPathPlan!.originalMovieFile.id) ||
        (await entry.target.client.fileVisibility(persisted.retainedPath)) !== 'file'
      ) {
        throw new Error('Radarr file identity or visibility changed before Plex deletion');
      }
    }
    const result = await deleteExactPlexTarget(target, snapshot, plexClient);
    live = result.live;
    confirmRadarrPlexRemoval(target, result.explicitDeleteSuccess);
  } else {
    if (target.plexAttemptCount <= 0) {
      throw new Error('Legacy Radarr reassignment requires explicit repair verification');
    }
    confirmRadarrPlexRemoval(target, false);
  }

  if (!live || live.media.some((entry) => entry.mediaId === snapshot.mediaId)) {
    throw new Error('Plex still reports the selected media version');
  }
  assertRetainedVersionPostcondition(target, snapshot, live);
  await waitForRadarrManagedPath(target, snapshot, client);
  advancePhase(target, 'plex_reconciliation');
  await reconcileArrReassignmentFinalState(target, snapshot, client);
  for (const persisted of snapshot.arrReassignments) {
    if (persisted.radarrPathPlan && persisted.radarrPathPlan.mode !== 'existing_path') {
      persistPathProgress(target, snapshot, persisted.instanceId, (current) => {
        current.radarrPathPlan!.transition = {
          ...current.radarrPathPlan!.transition,
          monitoringRestoredAt: Math.floor(Date.now() / 1000),
        };
      });
    }
  }
  await reconcilePlexTarget(target, snapshot);
}

export async function tryRecoverRadarrWithoutSelectedProjection(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): Promise<boolean> {
  if (
    target.targetKind !== 'movie_version' ||
    target.phase !== 'arr_coordination' ||
    !snapshot.arrReassignments?.length ||
    snapshot.arrReassignments.some((entry) => entry.instanceType !== 'radarr')
  ) {
    return false;
  }
  const client = await assertActivePlexIdentity(target, snapshot);
  const live = await client.metadataIdentity(snapshot.ratingKey);
  if (!live) throw new Error('The retained Plex item disappeared during Arr reassignment');
  await validateLiveDeletionIdentity(client, target.targetKind, snapshot, live);
  if (live.media.some((entry) => entry.mediaId === snapshot.mediaId)) return false;
  assertRetainedVersionPostcondition(target, snapshot, live);
  await ensureArrMonitoringEvidence(target, snapshot, client);

  if (target.plexAttemptCount > 0) {
    await coordinateRadarrReassignment(target, snapshot, client);
    return true;
  }
  if (radarrLegacyAccountingIsAmbiguous(target)) {
    throw new Error(
      'Legacy Radarr reassignment has ambiguous removal accounting and requires manual review',
    );
  }
  if (!(await radarrReassignmentAlreadyAdopted(target, snapshot, client, true))) {
    throw new Error('Legacy Radarr reassignment requires manual Radarr repair');
  }
  await reconcileArrReassignmentFinalState(target, snapshot, client);
  advancePhase(target, 'plex_reconciliation');
  await reconcilePlexTarget(target, snapshot);
  return true;
}
