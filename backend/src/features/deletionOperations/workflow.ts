import { and, eq, inArray } from 'drizzle-orm';
import { db, type SqliteClient, withTransaction } from '../../db/index.ts';
import {
  arrDeleteAttempts,
  downloadFileDeleteAttempts,
  items,
  torrentDeleteAttempts,
} from '../../db/schema.ts';
import { PlexDeleteError } from '../../integrations/plex/client.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
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
  waitForArrManagedPath,
} from './arrReassignment.ts';
import { refreshDeletionOperation } from './state.ts';
import {
  DeletionConvergenceError,
  type DeletionPhase,
  type DeletionWorkTarget,
  PlexReconciliationError,
} from './types.ts';
import {
  type DurableTargetSnapshot,
  validateDeletionTarget,
  validateLiveDeletionIdentity,
} from './validation.ts';

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

function advancePhase(target: DeletionWorkTarget, phase: DeletionPhase): void {
  const now = Math.floor(Date.now() / 1000);
  const changed = withTransaction((client) =>
    client.prepare(
      'UPDATE deletion_targets SET phase = ?, updated_at = ? WHERE id = ? AND status = ? AND phase = ?',
    ).run(phase, now, target.id, 'running', target.phase)
  );
  if (changed !== 1) throw new DeletionConvergenceError('deletion target state changed');
  target.phase = phase;
}

function confirmReassignedRemoval(
  target: DeletionWorkTarget,
): void {
  const now = Math.floor(Date.now() / 1000);
  withTransaction((client) => {
    const changed = client.prepare(
      `UPDATE deletion_targets
       SET removal_confirmed_at = COALESCE(removal_confirmed_at, ?),
           phase = 'plex_reconciliation', updated_at = ?
       WHERE id = ? AND status = 'running' AND phase = ?`,
    ).run(now, now, target.id, target.phase);
    if (changed !== 1) throw new DeletionConvergenceError('deletion target state changed');
    client.prepare(
      'INSERT OR IGNORE INTO media_removals (server_id, operation_id, target_kind, target_key, media_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      target.serverId,
      target.operationId,
      target.targetKind,
      target.targetKey,
      target.logicalSize,
      now,
    );
    refreshDeletionOperation(client, target.operationId);
  });
  target.phase = 'plex_reconciliation';
  target.removalConfirmedAt = now;
}

function finalizeTarget(
  client: SqliteClient,
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  attributable: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  const changed = client.prepare(
    "UPDATE deletion_targets SET status = 'completed', phase = 'finalizing', removal_confirmed_at = COALESCE(removal_confirmed_at, ?), plex_reconciled_at = ?, next_retry_at = NULL, error = NULL, warning = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND phase = 'plex_reconciliation'",
  ).run(now, now, now, target.id);
  if (changed !== 1) throw new DeletionConvergenceError('deletion target state changed');
  let removed = 0;
  if (target.targetKind === 'whole_item') {
    removed = client.prepare('DELETE FROM items WHERE server_id = ? AND rating_key = ?').run(
      target.serverId,
      snapshot.ratingKey,
    );
  } else if (target.targetKind === 'movie_version') {
    removed = client.prepare(
      'DELETE FROM item_media_versions WHERE server_id = ? AND item_rating_key = ? AND media_id = ?',
    ).run(target.serverId, snapshot.ratingKey, snapshot.mediaId!);
    client.prepare(
      'UPDATE items SET file_size = (SELECT SUM(file_size) FROM item_media_versions WHERE server_id = ? AND item_rating_key = ?) WHERE server_id = ? AND rating_key = ?',
    ).run(target.serverId, snapshot.ratingKey, target.serverId, snapshot.ratingKey);
  } else {
    removed = client.prepare(
      'DELETE FROM episode_media_versions WHERE server_id = ? AND episode_rating_key = ? AND media_id = ?',
    ).run(target.serverId, snapshot.ratingKey, snapshot.mediaId!);
    if (removed > 0) {
      const size = snapshot.fileSize ?? 0;
      client.prepare(
        'UPDATE seasons SET file_size = MAX(0, COALESCE(file_size, 0) - ?) WHERE server_id = ? AND rating_key = ?',
      ).run(size, target.serverId, snapshot.seasonRatingKey!);
      client.prepare(
        "UPDATE items SET file_size = MAX(0, COALESCE(file_size, 0) - ?) WHERE server_id = ? AND rating_key = ? AND type = 'show'",
      ).run(size, target.serverId, snapshot.showRatingKey!);
    }
  }
  if (attributable) {
    const kind = target.targetKind === 'whole_item' ? 'item' : target.targetKind;
    client.prepare(
      'INSERT OR IGNORE INTO media_removals (server_id, operation_id, target_kind, target_key, media_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      target.serverId,
      target.operationId,
      kind,
      target.targetKey,
      target.logicalSize,
      now,
    );
  }
  client.prepare('DELETE FROM media_version_reservations WHERE target_id = ?').run(target.id);
}

function permanentPlexFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = error instanceof PlexDeleteError ? error.status : null;
  if (status === 401 || status === 403) return true;
  return /(?:delet(?:e|ion).*(?:disabled|not allowed)|permission|unauthori[sz]ed|forbidden|read[- ]only|policy rejection)/i
    .test(error.message);
}

function assertRetainedVersionPostcondition(
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
  if (snapshot.arrOwnerships === undefined && snapshot.arrReassignments === undefined) return;
  const selectedIds = new Set(snapshot.selectedMediaIds ?? [snapshot.mediaId!]);
  const excludedIds = new Set(snapshot.operationMediaIds ?? [...selectedIds]);
  const [arrTargets, liveVersions] = await Promise.all([
    getArrDeleteTargets(target.serverId, snapshot.libraryKey),
    plexClient.mediaVersionPathPreviews(snapshot.ratingKey),
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
      ...(snapshot.type === 'episode' && snapshot.seasonIndex != null &&
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
    if (
      snapshot.arrReassignments?.length && plan.preview.arrReassignStatus !== 'resolved'
    ) {
      throw new Error(plan.preview.arrReassignReason ?? 'Arr reassignment is no longer confirmed');
    }
  } catch (error) {
    throw new PlexReconciliationError(
      error instanceof Error ? error.message : String(error),
      true,
      false,
    );
  }
}

async function reconcilePlexTarget(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): Promise<void> {
  // A committed Plex phase already proves that the initial Arr mutation and its
  // postcondition completed. Recheck only the current Arr postcondition here: the
  // projection-backed attempt row may legitimately have been pruned by a later sync.
  if (target.targetKind === 'whole_item') {
    await assertWholeItemArrPostcondition(target, snapshot);
  }

  const attemptStartedAt = Math.floor(Date.now() / 1000);
  const attemptChanged = withTransaction((client) =>
    client.prepare(
      `UPDATE deletion_targets
       SET plex_attempt_count = plex_attempt_count + 1, updated_at = ?
       WHERE id = ? AND status = 'running' AND phase = 'plex_reconciliation'`,
    ).run(attemptStartedAt, target.id)
  );
  if (attemptChanged !== 1) throw new DeletionConvergenceError('deletion target state changed');
  target.plexAttemptCount++;

  const active = await resolveActiveServer();
  if (active.serverId !== target.serverId || active.client.serverUrl !== snapshot.serverUrl) {
    throw new PlexReconciliationError(
      'the active Plex server changed after deletion was accepted',
      true,
      false,
    );
  }
  if (await active.client.identity() !== snapshot.machineIdentifier) {
    throw new PlexReconciliationError(
      'Plex machine identity changed after deletion was accepted',
      true,
      false,
    );
  }

  let live = await active.client.metadataIdentity(snapshot.ratingKey);
  if (live) {
    try {
      await validateLiveDeletionIdentity(active.client, target.targetKind, snapshot, live);
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
    await assertVersionArrPostcondition(target, snapshot, active.client);
    assertRetainedVersionPostcondition(target, snapshot, live);
  }

  const alreadyAbsent = target.targetKind === 'whole_item'
    ? live === null
    : !live!.media.some((entry) => entry.mediaId === snapshot.mediaId);
  if (alreadyAbsent) {
    withTransaction((client) => {
      finalizeTarget(client, target, snapshot, false);
      refreshDeletionOperation(client, target.operationId);
    });
    return;
  }

  const sessions = await active.client.activeSessions();
  if (activeWholeItemRatingKeys(new Set([snapshot.ratingKey]), sessions).size > 0) {
    throw new PlexReconciliationError('cannot delete media with active playback', true);
  }

  let deleteError: unknown = null;
  let explicitDeleteSuccess = false;
  try {
    if (target.targetKind === 'whole_item') {
      await active.client.deleteItem(snapshot.ratingKey);
    } else {
      await active.client.deleteMedia(snapshot.ratingKey, snapshot.mediaId!);
    }
    explicitDeleteSuccess = true;
  } catch (error) {
    deleteError = error;
  }

  try {
    live = await active.client.metadataIdentity(snapshot.ratingKey);
  } catch (error) {
    throw new PlexReconciliationError(
      `Plex deletion postcondition could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (live) {
    try {
      await validateLiveDeletionIdentity(active.client, target.targetKind, snapshot, live);
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
  withTransaction((client) => {
    finalizeTarget(client, target, snapshot, explicitDeleteSuccess);
    refreshDeletionOperation(client, target.operationId);
  });
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
    const plan = await buildVersionDeletionPlan({
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
    }
    if (retainedMediaId !== null) {
      if (plan.preview.arrReassignStatus !== 'resolved') {
        throw new Error(
          plan.preview.arrReassignReason ?? 'Arr reassignment could not be verified',
        );
      }
      await waitForArrManagedPath(
        target,
        plan,
        snapshot,
        client,
        retainedMediaId,
      );
      confirmReassignedRemoval(target);
      await reconcilePlexTarget(target, snapshot);
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
        await waitForArrManagedPath(
          target,
          finalPlan,
          snapshot,
          client,
          candidateMediaId,
        );
        confirmReassignedRemoval(target);
        await reconcilePlexTarget(target, snapshot);
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
      await reconcilePlexTarget(target, snapshot);
      return;
    }
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
