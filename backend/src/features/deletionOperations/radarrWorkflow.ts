import { buildVersionDeletionPlan } from '../mediaDeletion/versionPlanning.ts';
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
} from './deletionState.ts';
import {
  assertActivePlexIdentity,
  assertRetainedVersionPostcondition,
  deleteExactPlexTarget,
  reconcilePlexTarget,
} from './plexReconciliation.ts';
import type { DeletionWorkTarget } from './types.ts';
import {
  type DurableTargetSnapshot,
  validateDeletionTarget,
  validateLiveDeletionIdentity,
} from './validation.ts';

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
  ) throw new Error('The persisted Radarr reassignment plan is incomplete');
  await ensureArrMonitoringEvidence(target, snapshot, client);

  const plexClient = await assertActivePlexIdentity(target, snapshot);
  let live = await plexClient.metadataIdentity(snapshot.ratingKey);
  if (!live) throw new Error('The retained Plex item disappeared during Arr reassignment');
  await validateLiveDeletionIdentity(plexClient, target.targetKind, snapshot, live);
  assertRetainedVersionPostcondition(target, snapshot, live);
  const selectedPresent = live.media.some((entry) => entry.mediaId === snapshot.mediaId);

  if (selectedPresent) {
    for (const persisted of snapshot.arrReassignments) {
      let entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
      // Revalidate the complete destructive boundary after monitoring protection
      // has converged and immediately before the Plex-first mutation.
      entry = await ensureArrReassignmentProtected(target, snapshot, client, persisted);
      if (
        entry.managedFileId !== persisted.managedFileId ||
        entry.managedPath === null ||
        entry.managedPath !== persisted.managedPath ||
        await entry.target.client.fileVisibility(persisted.managedPath) !== 'file' ||
        await entry.target.client.fileVisibility(persisted.retainedPath) !== 'file'
      ) throw new Error('Radarr file visibility changed before Plex deletion');
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
  await reconcilePlexTarget(target, snapshot);
}

export async function tryRecoverRadarrWithoutSelectedProjection(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): Promise<boolean> {
  if (
    target.targetKind !== 'movie_version' || target.phase !== 'arr_coordination' ||
    !snapshot.arrReassignments?.length ||
    snapshot.arrReassignments.some((entry) => entry.instanceType !== 'radarr')
  ) return false;
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
  if (!await radarrReassignmentAlreadyAdopted(target, snapshot, client, true)) {
    throw new Error('Legacy Radarr reassignment requires manual Radarr repair');
  }
  await reconcileArrReassignmentFinalState(target, snapshot, client);
  advancePhase(target, 'plex_reconciliation');
  await reconcilePlexTarget(target, snapshot);
  return true;
}
