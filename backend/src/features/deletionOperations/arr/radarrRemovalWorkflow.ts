import { withTransaction } from '../../../db/index.ts';
import { getArrDeleteTargets } from '../../arr/delete.ts';
import { normalizeRemoteAbsolute } from '../../mediaDeletion/hardlinks.ts';
import { assertVersionIsNotPlaying } from './arrReassignment.ts';
import { DeletionConvergenceError, type DeletionWorkTarget } from '../core/types.ts';
import {
  type DurableTargetSnapshot,
  validateDeletionTarget,
  validateLiveDeletionIdentity,
} from '../core/validation.ts';

function samePath(left: string | null, right: string): boolean {
  return (
    left !== null &&
    normalizeRemoteAbsolute(left)?.comparison === normalizeRemoteAbsolute(right)?.comparison
  );
}

type RadarrRemovalPlan = NonNullable<DurableTargetSnapshot['radarrRemovalFallback']>;

export function assertRadarrRemovalActivityIsQuiet(
  activity: { quiet: boolean },
  boundary: 'before_protection' | 'before_removal' | 'after_removal',
): void {
  if (!activity.quiet) {
    throw new Error(
      boundary === 'after_removal'
        ? 'Radarr has conflicting movie activity after removal'
        : 'Radarr has conflicting movie activity',
    );
  }
}

export function assertRadarrRemovalPlexVersions(
  liveVersions: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof validateDeletionTarget>>['client']['mediaVersionPathPreviews']
    >
  >,
  plan: RadarrRemovalPlan,
  options: { allowSelectedAbsent?: boolean } = {},
): void {
  const selected = liveVersions.find((entry) => entry.mediaId === plan.selectedMediaId);
  const retained = liveVersions.find((entry) => entry.mediaId === plan.retainedMediaId);
  if (
    (!selected && !options.allowSelectedAbsent) ||
    (selected !== undefined &&
      (selected.truncated ||
        selected.paths.length !== 1 ||
        !samePath(selected.paths[0]!, plan.selectedPlexPath)))
  ) {
    throw new Error('The selected Plex version changed before Radarr removal');
  }
  if (
    !retained ||
    retained.truncated ||
    retained.paths.length !== 1 ||
    !samePath(retained.paths[0]!, plan.retainedPlexPath) ||
    (retained.fileSize ?? retained.projectedFileSize ?? 0) !== plan.retainedFileSize
  ) {
    throw new Error('The retained Plex version changed before Radarr removal');
  }
}

function persistRemovalProgress(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  update: (plan: NonNullable<DurableTargetSnapshot['radarrRemovalFallback']>) => void,
): void {
  const before = JSON.stringify(snapshot);
  const next = structuredClone(snapshot);
  if (!next.radarrRemovalFallback) throw new Error('The durable Radarr removal plan is missing');
  update(next.radarrRemovalFallback);
  const now = Math.floor(Date.now() / 1000);
  const changed = withTransaction((db) =>
    db
      .prepare(
        "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running' AND snapshot = ?",
      )
      .run(JSON.stringify(next), now, target.id, before)
  );
  if (changed !== 1) {
    throw new DeletionConvergenceError('Could not persist Radarr removal progress');
  }
  snapshot.radarrRemovalFallback = next.radarrRemovalFallback;
  target.snapshot = JSON.stringify(next);
}

export function assertRecoverableRadarrRemovalMonitoringState(
  originalMonitored: boolean,
  liveMonitored: boolean,
  protectionAttempted: boolean,
): void {
  if (!protectionAttempted && liveMonitored !== originalMonitored) {
    throw new Error('Radarr monitoring changed; preview the deletion again');
  }
  if (protectionAttempted && !originalMonitored && liveMonitored) {
    throw new Error('Radarr monitoring changed after protection was attempted');
  }
}

export async function coordinateRadarrRemovalFallback(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
): Promise<void> {
  const plan = snapshot.radarrRemovalFallback;
  if (!plan || plan.userAuthorizedRadarrRemoval !== true) {
    throw new Error('Radarr movie removal was not explicitly authorized');
  }
  if (target.targetKind !== 'movie_version' || snapshot.tmdbId !== plan.tmdbId) {
    throw new Error('Radarr removal is available only for the exact persisted movie');
  }
  const live = await client.metadataIdentity(snapshot.ratingKey);
  if (!live) throw new Error('The retained Plex item disappeared before Radarr removal');
  await validateLiveDeletionIdentity(client, target.targetKind, snapshot, live);
  const liveVersions = await client.mediaVersionPathPreviews(snapshot.ratingKey);
  assertRadarrRemovalPlexVersions(liveVersions, plan, { allowSelectedAbsent: true });

  const targets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
  const arrTarget = targets.find((entry) => entry.instanceId === plan.arrInstanceId);
  const mapping = snapshot.arrReassignmentMappings?.find(
    (entry) => entry.instanceId === plan.arrInstanceId,
  );
  if (
    !arrTarget ||
    arrTarget.instanceType !== 'radarr' ||
    !mapping ||
    plan.arrConfigurationUpdatedAt !== mapping.configurationUpdatedAt ||
    plan.arrMappingIdentity !== mapping.mappingIdentity ||
    mapping.configurationUpdatedAt !== arrTarget.configurationUpdatedAt ||
    mapping.mappingIdentity !== arrTarget.mappingIdentity
  ) {
    throw new Error('The persisted Radarr instance configuration changed');
  }
  const ownership = snapshot.arrOwnerships?.find((entry) =>
    entry.instanceId === plan.arrInstanceId && entry.managedMediaId === plan.selectedMediaId
  );

  let movie = await arrTarget.client.lookup(plan.tmdbId);
  if (!movie && await arrTarget.client.radarrMovieExistsById(plan.movieId)) {
    throw new Error('The original Radarr movie ID still exists with a changed identity');
  }
  if (movie) {
    assertRadarrRemovalPlexVersions(liveVersions, plan);
    if (
      movie.id !== plan.movieId ||
      movie.path !== plan.originalMoviePath ||
      movie.title !== plan.movieTitle ||
      movie.year !== plan.movieYear ||
      typeof movie.monitored !== 'boolean'
    ) {
      throw new Error('The exact Radarr movie identity changed');
    }
    const managedFile = await arrTarget.client.radarrManagedFile(plan.movieId);
    if (
      !managedFile || !ownership || ownership.managedFileId !== managedFile.id ||
      !samePath(managedFile.path, plan.managedPath) ||
      ownership.managedPath === null || !samePath(ownership.managedPath, plan.managedPath)
    ) throw new Error('Radarr no longer owns the exact selected Plex version');
    const protectionAttempted = plan.transition?.monitoringProtectionAttemptedAt !== undefined;
    assertRecoverableRadarrRemovalMonitoringState(
      plan.originalMonitored,
      movie.monitored,
      protectionAttempted,
    );
    const activity = await arrTarget.client.radarrMovieActivity(plan.movieId);
    assertRadarrRemovalActivityIsQuiet(activity, 'before_protection');
    if (!protectionAttempted) {
      persistRemovalProgress(target, snapshot, (current) => {
        current.transition = {
          ...current.transition,
          monitoringProtectionAttemptedAt: Math.floor(Date.now() / 1000),
        };
      });
    }
    await arrTarget.client.setRadarrMovieMonitored(
      {
        movieId: plan.movieId,
        tmdbId: plan.tmdbId,
        path: plan.originalMoviePath,
      },
      false,
    );
    persistRemovalProgress(target, snapshot, (current) => {
      current.transition = {
        ...current.transition,
        monitoringProtectedAt: Math.floor(Date.now() / 1000),
      };
    });
  }

  let exclusions = await arrTarget.client.radarrImportExclusions();
  let matches = exclusions.filter((entry) => entry.tmdbId === plan.tmdbId);
  let createdThisOperation = plan.transition?.exclusionCreationAttemptedAt !== undefined &&
    plan.exclusionPreexisting !== true;
  if (matches.length > 1) throw new Error('Radarr import exclusion identity is ambiguous');
  if (matches.length === 0) {
    if (!movie) throw new Error('Radarr movie is absent but its import exclusion is missing');
    persistRemovalProgress(target, snapshot, (current) => {
      current.transition = {
        ...current.transition,
        exclusionCreationAttemptedAt: Math.floor(Date.now() / 1000),
      };
    });
    createdThisOperation = true;
    try {
      const created = await arrTarget.client.createRadarrImportExclusion({
        tmdbId: plan.tmdbId,
        movieTitle: plan.movieTitle,
        movieYear: plan.movieYear,
      });
      persistRemovalProgress(
        target,
        snapshot,
        (current) => (current.createdExclusionId = created.id),
      );
    } catch (error) {
      const recovered = await arrTarget.client.radarrImportExclusions();
      if (!recovered.some((entry) => entry.tmdbId === plan.tmdbId)) throw error;
    }
    exclusions = await arrTarget.client.radarrImportExclusions();
    matches = exclusions.filter((entry) => entry.tmdbId === plan.tmdbId);
  } else if (!createdThisOperation) {
    persistRemovalProgress(target, snapshot, (current) => (current.exclusionPreexisting = true));
  }
  if (matches.length !== 1) throw new Error('Radarr import exclusion could not be verified');
  const createdExclusionId = snapshot.radarrRemovalFallback?.createdExclusionId;
  if (
    createdThisOperation &&
    ((createdExclusionId !== undefined && matches[0]!.id !== createdExclusionId) ||
      matches[0]!.movieTitle !== plan.movieTitle || matches[0]!.movieYear !== plan.movieYear)
  ) {
    throw new Error('The created Radarr import exclusion identity changed');
  }
  persistRemovalProgress(target, snapshot, (current) => {
    current.transition = {
      ...current.transition,
      exclusionConfirmedAt: Math.floor(Date.now() / 1000),
    };
  });

  movie = await arrTarget.client.lookup(plan.tmdbId);
  if (movie) {
    await assertVersionIsNotPlaying(client, snapshot.ratingKey);
    assertRadarrRemovalPlexVersions(
      await client.mediaVersionPathPreviews(snapshot.ratingKey),
      plan,
    );
    const activity = await arrTarget.client.radarrMovieActivity(plan.movieId);
    assertRadarrRemovalActivityIsQuiet(activity, 'before_removal');
    const managedFile = await arrTarget.client.radarrManagedFile(plan.movieId);
    if (
      movie.id !== plan.movieId ||
      movie.path !== plan.originalMoviePath ||
      movie.title !== plan.movieTitle ||
      movie.year !== plan.movieYear ||
      movie.monitored !== false ||
      !managedFile ||
      !ownership ||
      managedFile.id !== ownership.managedFileId ||
      !samePath(managedFile.path, plan.managedPath)
    ) {
      throw new Error('Radarr movie is not protected and quiet before removal');
    }
    persistRemovalProgress(target, snapshot, (current) => {
      current.transition = {
        ...current.transition,
        removalAttemptedAt: Math.floor(Date.now() / 1000),
      };
    });
    try {
      await arrTarget.client.removeRadarrMovieWithoutFiles(plan.movieId);
    } catch (error) {
      if (
        await arrTarget.client.radarrMovieExistsById(plan.movieId) ||
        await arrTarget.client.lookup(plan.tmdbId)
      ) throw error;
    }
  }
  if (await arrTarget.client.radarrMovieExistsById(plan.movieId)) {
    throw new Error('The original Radarr movie ID still exists after removal');
  }
  if (await arrTarget.client.lookup(plan.tmdbId)) {
    throw new Error('Radarr movie removal could not be verified');
  }
  const confirmedExclusions = (await arrTarget.client.radarrImportExclusions()).filter(
    (entry) => entry.tmdbId === plan.tmdbId,
  );
  if (confirmedExclusions.length !== 1) {
    throw new Error('Radarr import exclusion disappeared after movie removal');
  }
  const postRemovalActivity = await arrTarget.client.radarrMovieActivity(plan.movieId);
  assertRadarrRemovalActivityIsQuiet(postRemovalActivity, 'after_removal');
  persistRemovalProgress(target, snapshot, (current) => {
    current.transition = {
      ...current.transition,
      movieAbsenceConfirmedAt: Math.floor(Date.now() / 1000),
    };
  });
}
