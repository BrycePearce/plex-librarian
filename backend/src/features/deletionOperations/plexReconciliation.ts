import { type SqliteClient, withTransaction } from '../../db/index.ts';
import { PlexDeleteError } from '../../integrations/plex/client.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { activeWholeItemRatingKeys } from '../mediaDeletion/activePlayback.ts';
import { buildVersionDeletionPlan } from '../mediaDeletion/versionPlanning.ts';
import {
  assertAcceptedArrMappingsUnchanged,
  persistedArrOwnershipMap,
  persistedArrReassignmentMap,
  persistedRetainedMediaId,
  radarrReassignmentAlreadyAdopted,
} from './arrReassignment.ts';
import { radarrLegacyAccountingIsAmbiguous } from './deletionState.ts';
import { refreshDeletionOperation } from './state.ts';
import {
  DeletionConvergenceError,
  type DeletionWorkTarget,
  PlexReconciliationError,
} from './types.ts';
import {
  type DurableTargetSnapshot,
  validateDeletionTarget,
  validateLiveDeletionIdentity,
} from './validation.ts';

function externalId(snapshot: DurableTargetSnapshot): number | null {
  return snapshot.type === 'movie'
    ? snapshot.tmdbId
    : snapshot.type === 'show'
    ? snapshot.tvdbId
    : null;
}

function finalizeTarget(
  client: SqliteClient,
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  attributable: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  const changed = client
    .prepare(
      "UPDATE deletion_targets SET status = 'completed', phase = 'finalizing', removal_confirmed_at = COALESCE(removal_confirmed_at, ?), plex_reconciled_at = ?, next_retry_at = NULL, error = NULL, warning = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND phase = 'plex_reconciliation'",
    )
    .run(now, now, now, target.id);
  if (changed !== 1) throw new DeletionConvergenceError('deletion target state changed');
  let removed = 0;
  if (target.targetKind === 'whole_item') {
    removed = client
      .prepare('DELETE FROM items WHERE server_id = ? AND rating_key = ?')
      .run(target.serverId, snapshot.ratingKey);
  } else if (target.targetKind === 'movie_version') {
    removed = client
      .prepare(
        'DELETE FROM item_media_versions WHERE server_id = ? AND item_rating_key = ? AND media_id = ?',
      )
      .run(target.serverId, snapshot.ratingKey, snapshot.mediaId!);
    client
      .prepare(
        'UPDATE items SET file_size = (SELECT SUM(file_size) FROM item_media_versions WHERE server_id = ? AND item_rating_key = ?) WHERE server_id = ? AND rating_key = ?',
      )
      .run(target.serverId, snapshot.ratingKey, target.serverId, snapshot.ratingKey);
  } else {
    removed = client
      .prepare(
        'DELETE FROM episode_media_versions WHERE server_id = ? AND episode_rating_key = ? AND media_id = ?',
      )
      .run(target.serverId, snapshot.ratingKey, snapshot.mediaId!);
    if (removed > 0) {
      const size = snapshot.fileSize ?? 0;
      client
        .prepare(
          'UPDATE seasons SET file_size = MAX(0, COALESCE(file_size, 0) - ?) WHERE server_id = ? AND rating_key = ?',
        )
        .run(size, target.serverId, snapshot.seasonRatingKey!);
      client
        .prepare(
          "UPDATE items SET file_size = MAX(0, COALESCE(file_size, 0) - ?) WHERE server_id = ? AND rating_key = ? AND type = 'show'",
        )
        .run(size, target.serverId, snapshot.showRatingKey!);
    }
  }
  if (attributable) {
    const kind = target.targetKind === 'whole_item' ? 'item' : target.targetKind;
    client
      .prepare(
        'INSERT OR IGNORE INTO media_removals (server_id, operation_id, target_kind, target_key, media_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(target.serverId, target.operationId, kind, target.targetKey, target.logicalSize, now);
  }
  client.prepare('DELETE FROM media_version_reservations WHERE target_id = ?').run(target.id);
  client.prepare('DELETE FROM radarr_movie_reservations WHERE target_id = ?').run(target.id);
}

function permanentPlexFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = error instanceof PlexDeleteError ? error.status : null;
  if (status === 401 || status === 403) return true;
  return /(?:delet(?:e|ion).*(?:disabled|not allowed)|permission|unauthori[sz]ed|forbidden|read[- ]only|policy rejection)/i
    .test(
      error.message,
    );
}

export function assertRetainedVersionPostcondition(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  live: NonNullable<Awaited<ReturnType<typeof validateDeletionTarget>>['live']>,
): void {
  const liveIds = new Set(live.media.map((entry) => entry.mediaId));
  const retainedMediaId = persistedRetainedMediaId(snapshot);
  if (retainedMediaId !== null) {
    if (!liveIds.has(retainedMediaId)) {
      throw new PlexReconciliationError(
        'The retained Plex version disappeared during reconciliation',
        true,
        false,
      );
    }
    return;
  }
  const operationIds = new Set(snapshot.operationMediaIds ?? [snapshot.mediaId!]);
  if (![...liveIds].some((mediaId) => !operationIds.has(mediaId))) {
    throw new PlexReconciliationError(
      'at least one unselected live Plex version must remain',
      true,
      false,
    );
  }
  if (target.targetKind === 'whole_item') {
    throw new PlexReconciliationError('invalid retained-version check', true, false);
  }
}

async function assertWholeItemArrPostcondition(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): Promise<void> {
  if (snapshot.mode === 'coordinated') {
    const id = externalId(snapshot);
    if (id === null) {
      throw new PlexReconciliationError('the target has no Arr external ID', true, false);
    }
    const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
    for (const entry of arrTargets) {
      const record = await entry.client.lookup(id);
      if (record) {
        throw new PlexReconciliationError(
          `${entry.instanceName} still reports the item after coordinated deletion`,
          true,
          false,
        );
      }
    }
    return;
  }
  if (!snapshot.unmonitorFromArr) return;
  if (snapshot.tmdbId === null) {
    throw new PlexReconciliationError('Radarr movie identity is required', true, false);
  }
  const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
  let matched = false;
  for (const entry of arrTargets) {
    const record = await entry.client.lookup(snapshot.tmdbId);
    if (!record) continue;
    const monitorTarget = await entry.client.monitorTarget(record.id);
    if (!monitorTarget) continue;
    matched = true;
    if (monitorTarget.monitored !== false) {
      throw new PlexReconciliationError(
        `${entry.instanceName} no longer reports the item as unmonitored`,
        true,
        false,
      );
    }
  }
  if (!matched) {
    throw new PlexReconciliationError(
      'No matching Radarr movie was found to confirm unmonitoring',
      true,
      false,
    );
  }
}

async function assertVersionArrPostcondition(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  plexClient: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
): Promise<void> {
  if (snapshot.radarrRemovalFallback) {
    const plan = snapshot.radarrRemovalFallback;
    const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
    assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, arrTargets);
    const arrTarget = arrTargets.find((entry) => entry.instanceId === plan.arrInstanceId);
    if (
      !arrTarget ||
      (await arrTarget.client.radarrMovieExistsById(plan.movieId)) ||
      (await arrTarget.client.lookup(plan.tmdbId))
    ) {
      throw new Error('Radarr movie absence is no longer confirmed');
    }
    if (
      !(await arrTarget.client.radarrImportExclusions()).some(
        (entry) => entry.tmdbId === plan.tmdbId,
      )
    ) {
      throw new Error('Radarr import exclusion is no longer confirmed');
    }
    return;
  }
  if (snapshot.arrOwnerships === undefined && snapshot.arrReassignments === undefined) return;
  const selectedIds = new Set(snapshot.selectedMediaIds ?? [snapshot.mediaId!]);
  const excludedIds = new Set(snapshot.operationMediaIds ?? [...selectedIds]);
  const [arrTargets, liveVersions, liveIdentity] = await Promise.all([
    getArrDeleteTargets(target.serverId, snapshot.libraryKey),
    plexClient.mediaVersionPathPreviews(snapshot.ratingKey),
    plexClient.metadataIdentity(snapshot.ratingKey),
  ]);
  try {
    assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, arrTargets);
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
      requiredOwnerships: persistedArrOwnershipMap(snapshot),
      requiredReassignments: persistedArrReassignmentMap(snapshot),
      serverId: target.serverId,
      libraryKey: snapshot.libraryKey,
      plexClient,
      versionRanks: liveIdentity?.media ?? [],
      ...(snapshot.type === 'episode' &&
          snapshot.seasonIndex != null &&
          snapshot.episodeIndex != null
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
    if (snapshot.arrReassignments?.length && plan.preview.arrReassignStatus !== 'resolved') {
      throw new Error(plan.preview.arrReassignReason ?? 'Arr reassignment is no longer confirmed');
    }
    if (
      target.targetKind === 'movie_version' &&
      snapshot.arrReassignments?.length &&
      target.plexAttemptCount === 0 &&
      radarrLegacyAccountingIsAmbiguous(target)
    ) {
      throw new Error(
        'Legacy Radarr reassignment has ambiguous removal accounting and requires manual review',
      );
    }
    if (
      target.targetKind === 'movie_version' &&
      snapshot.arrReassignments?.length &&
      !(await radarrReassignmentAlreadyAdopted(
        target,
        snapshot,
        plexClient,
        target.plexAttemptCount === 0,
      ))
    ) {
      throw new Error('Radarr no longer reports the exact retained-file adoption');
    }
  } catch (error) {
    throw new PlexReconciliationError(
      error instanceof Error ? error.message : String(error),
      true,
      false,
    );
  }
}

export async function deleteExactPlexTarget(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  client: Awaited<ReturnType<typeof validateDeletionTarget>>['client'],
): Promise<{
  live: Awaited<ReturnType<typeof validateDeletionTarget>>['live'];
  explicitDeleteSuccess: boolean;
}> {
  const sessions = await client.activeSessions();
  if (activeWholeItemRatingKeys(new Set([snapshot.ratingKey]), sessions).size > 0) {
    throw new PlexReconciliationError('cannot delete media with active playback', true);
  }
  const attemptStartedAt = Math.floor(Date.now() / 1000);
  const attemptChanged = withTransaction((sqlite) =>
    sqlite
      .prepare(
        `UPDATE deletion_targets
       SET plex_attempt_count = plex_attempt_count + 1, updated_at = ?
       WHERE id = ? AND status = 'running' AND phase = ?`,
      )
      .run(attemptStartedAt, target.id, target.phase)
  );
  if (attemptChanged !== 1) throw new DeletionConvergenceError('deletion target state changed');
  target.plexAttemptCount++;

  let deleteError: unknown = null;
  let explicitDeleteSuccess = false;
  try {
    if (target.targetKind === 'whole_item') {
      await client.deleteItem(snapshot.ratingKey);
    } else {
      await client.deleteMedia(snapshot.ratingKey, snapshot.mediaId!);
    }
    explicitDeleteSuccess = true;
  } catch (error) {
    deleteError = error;
  }

  let live: Awaited<ReturnType<typeof validateDeletionTarget>>['live'];
  try {
    live = await client.metadataIdentity(snapshot.ratingKey);
  } catch (error) {
    throw new PlexReconciliationError(
      `Plex deletion postcondition could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (live) {
    try {
      await validateLiveDeletionIdentity(client, target.targetKind, snapshot, live);
    } catch (error) {
      throw new PlexReconciliationError(
        error instanceof Error ? error.message : String(error),
        true,
        false,
      );
    }
  }
  if (target.targetKind !== 'whole_item' && live) {
    assertRetainedVersionPostcondition(target, snapshot, live);
  }
  const absent = target.targetKind === 'whole_item'
    ? live === null
    : live !== null && !live.media.some((entry) => entry.mediaId === snapshot.mediaId);
  if (!absent) {
    if (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : String(deleteError);
      const unsupported404 = deleteError instanceof PlexDeleteError && deleteError.status === 404;
      throw new PlexReconciliationError(
        message,
        unsupported404 || permanentPlexFailure(deleteError),
      );
    }
    throw new PlexReconciliationError(
      target.targetKind === 'whole_item'
        ? 'Plex still reports the item after deletion'
        : 'Plex still reports the media version after deletion',
    );
  }
  return { live, explicitDeleteSuccess };
}

export async function assertActivePlexIdentity(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
) {
  const active = await resolveActiveServer();
  if (active.serverId !== target.serverId || active.client.serverUrl !== snapshot.serverUrl) {
    throw new PlexReconciliationError(
      'the active Plex server changed after deletion was accepted',
      true,
      false,
    );
  }
  if ((await active.client.identity()) !== snapshot.machineIdentifier) {
    throw new PlexReconciliationError(
      'Plex machine identity changed after deletion was accepted',
      true,
      false,
    );
  }
  return active.client;
}

export async function reconcilePlexTarget(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): Promise<void> {
  if (target.targetKind === 'whole_item') {
    await assertWholeItemArrPostcondition(target, snapshot);
  }
  const client = await assertActivePlexIdentity(target, snapshot);
  const live = await client.metadataIdentity(snapshot.ratingKey);
  if (live) {
    try {
      await validateLiveDeletionIdentity(client, target.targetKind, snapshot, live);
    } catch (error) {
      throw new PlexReconciliationError(
        error instanceof Error ? error.message : String(error),
        true,
        false,
      );
    }
  }
  if (target.targetKind !== 'whole_item') {
    const arrTargets = await getArrDeleteTargets(target.serverId, snapshot.libraryKey);
    try {
      assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, arrTargets);
    } catch (error) {
      throw new PlexReconciliationError(
        error instanceof Error ? error.message : String(error),
        true,
        false,
      );
    }
    if (!live) {
      throw new PlexReconciliationError(
        'The Plex item disappeared, so a retained version cannot be confirmed',
        true,
        false,
      );
    }
    await assertVersionArrPostcondition(target, snapshot, client);
    assertRetainedVersionPostcondition(target, snapshot, live);
  }

  const alreadyAbsent = target.targetKind === 'whole_item'
    ? live === null
    : !live!.media.some((entry) => entry.mediaId === snapshot.mediaId);
  if (alreadyAbsent) {
    withTransaction((sqlite) => {
      finalizeTarget(sqlite, target, snapshot, false);
      refreshDeletionOperation(sqlite, target.operationId);
    });
    return;
  }
  const result = await deleteExactPlexTarget(target, snapshot, client);
  withTransaction((sqlite) => {
    finalizeTarget(sqlite, target, snapshot, result.explicitDeleteSuccess);
    refreshDeletionOperation(sqlite, target.operationId);
  });
}
