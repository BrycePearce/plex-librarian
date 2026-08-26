import { withTransaction } from '../../../db/index.ts';
import { ArrApiError, type ArrClient } from '../../../integrations/arr/client.ts';
import { getArrDeleteTargets } from '../../arr/delete.ts';
import { assertAcceptedArrMappingsUnchanged } from '../arr/arrReassignment.ts';
import {
  sonarrRescanHasOnlyAuthorizedChange,
  sonarrRescanHasOnlyAuthorizedChanges,
} from '../arr/sonarrSnapshotPolicy.ts';
import { refreshDeletionOperation } from '../core/state.ts';
import type { DeletionWorkTarget } from '../core/types.ts';
import { type DurableTargetSnapshot, validateDeletionTarget } from '../core/validation.ts';

export class SonarrSeasonRecoveryConflictError extends Error {
  constructor(message: string, readonly status: 404 | 409 = 409) {
    super(message);
  }
}

async function assertSonarrExactFileAbsent(client: ArrClient, path: string): Promise<void> {
  try {
    if (await client.sonarrExactFileExists(path)) {
      throw new SonarrSeasonRecoveryConflictError(
        'Sonarr still sees the exact managed file',
      );
    }
  } catch (error) {
    if (error instanceof SonarrSeasonRecoveryConflictError) throw error;
    if (error instanceof ArrApiError) {
      throw new SonarrSeasonRecoveryConflictError(
        `Could not verify exact-file absence in Sonarr; no recovery change was made: ${error.message}`,
      );
    }
    throw error;
  }
}

function recoveryTarget(
  operationId: string,
  targetId: number,
  serverId: number,
): DeletionWorkTarget {
  const row = withTransaction((client) =>
    client.prepare(
      `SELECT t.id, t.operation_id, o.server_id, t.target_kind, t.target_key, t.snapshot,
              t.logical_size, t.phase, t.removal_confirmed_at, t.plex_attempt_count
       FROM deletion_targets t
       JOIN deletion_operations o ON o.id = t.operation_id
       WHERE t.id = ? AND t.operation_id = ? AND o.server_id = ?
         AND t.status = 'needs_attention' AND t.phase = 'arr_coordination'`,
    ).value<unknown[]>(targetId, operationId, serverId)
  );
  if (!row) throw new SonarrSeasonRecoveryConflictError('Sonarr recovery target not found', 404);
  return {
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
  };
}

export async function acceptSonarrRemovedAndUnmonitored(
  operationId: string,
  targetId: number,
  serverId: number,
): Promise<void> {
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    throw new SonarrSeasonRecoveryConflictError('Sonarr recovery target not found', 404);
  }
  const target = recoveryTarget(operationId, targetId, serverId);
  const validated = await validateDeletionTarget(serverId, target);
  const snapshot = validated.snapshot;
  if (
    target.targetKind !== 'episode_version' || snapshot.seasonCleanup !== true ||
    snapshot.seasonCoordinationOutcome !== 'automatic_adoption'
  ) {
    throw new SonarrSeasonRecoveryConflictError(
      'This target is not a failed Sonarr retained-version adoption',
    );
  }
  const persisted = snapshot.arrReassignments?.filter((entry) => entry.instanceType === 'sonarr');
  if (persisted?.length !== 1 || persisted[0]!.episodeId === null) {
    throw new SonarrSeasonRecoveryConflictError('Durable Sonarr recovery evidence is incomplete');
  }
  const reassignment = persisted[0]!;
  const episodeId = reassignment.episodeId!;
  if (!Number.isSafeInteger(reassignment.managedFileSize) || reassignment.managedFileSize! <= 0) {
    throw new SonarrSeasonRecoveryConflictError('Durable Sonarr file-size evidence is incomplete');
  }
  if (!validated.live) {
    throw new SonarrSeasonRecoveryConflictError('The retained Plex episode is no longer available');
  }
  const retainedIds = new Set(
    snapshot.expectedRetainedVersions?.map((entry) => entry.mediaId) ?? [],
  );
  if (!validated.live.media.some((entry) => retainedIds.has(entry.mediaId))) {
    throw new SonarrSeasonRecoveryConflictError(
      'No authorized retained Plex version remains available',
    );
  }

  const targets = await getArrDeleteTargets(serverId, snapshot.libraryKey);
  assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, targets);
  const sonarr = targets.find((entry) =>
    entry.instanceType === 'sonarr' && entry.instanceId === reassignment.instanceId
  );
  if (!sonarr) {
    throw new SonarrSeasonRecoveryConflictError('The accepted Sonarr instance is unavailable');
  }
  const capabilities = await sonarr.client.sonarrSeasonCoordinationCapabilities();
  if (
    !capabilities.available || !capabilities.version ||
    capabilities.version !== snapshot.seasonSonarrVersion
  ) {
    throw new SonarrSeasonRecoveryConflictError(
      'The accepted Sonarr version changed or is outside the supported v4 baseline',
    );
  }
  if (snapshot.tvdbId === null) {
    throw new SonarrSeasonRecoveryConflictError('The durable Sonarr series identity is incomplete');
  }
  const series = await sonarr.client.lookup(snapshot.tvdbId);
  if (!series || series.id !== reassignment.recordId || series.path !== reassignment.recordPath) {
    throw new SonarrSeasonRecoveryConflictError('The accepted Sonarr series identity changed');
  }
  const state = await sonarr.client.sonarrSeriesSnapshot(reassignment.recordId);
  const episode = state.episodes.find((entry) => entry.id === episodeId);
  if (
    !episode || episode.seriesId !== reassignment.recordId ||
    episode.seasonNumber !== snapshot.seasonIndex ||
    episode.episodeNumber !== snapshot.episodeIndex || episode.monitored !== false ||
    episode.episodeFileId !== 0 ||
    state.files.some((entry) =>
      entry.id === reassignment.managedFileId || entry.episodeIds.includes(episodeId)
    )
  ) {
    throw new SonarrSeasonRecoveryConflictError(
      'Sonarr is not in the exact removed-and-unmonitored recovery state',
    );
  }
  await assertSonarrExactFileAbsent(sonarr.client, reassignment.managedPath);

  const now = Math.floor(Date.now() / 1000);
  const next: DurableTargetSnapshot = {
    ...snapshot,
    seasonCoordinationOutcome: 'removed_and_unmonitored',
    seasonBreakGlass: {
      instanceId: reassignment.instanceId,
      seriesId: reassignment.recordId,
      episodeId,
      episodeFileId: reassignment.managedFileId,
      episodeFilePath: reassignment.managedPath,
      episodeFileSize: reassignment.managedFileSize!,
      originalMonitored: reassignment.originalMonitored,
      monitoringProtectedAt: now,
      fileRemovalAttemptedAt: now,
      fileRemovalConfirmedAt: now,
      recoveryAcceptedAt: now,
    },
  };
  const changed = withTransaction((client) => {
    const count = client.prepare(
      `UPDATE deletion_targets
       SET snapshot = ?, status = 'queued', attempt_count = 0, next_retry_at = NULL,
           error = NULL, updated_at = ?
       WHERE id = ? AND operation_id = ? AND status = 'needs_attention'
         AND phase = 'arr_coordination' AND snapshot = ?`,
    ).run(JSON.stringify(next), now, targetId, operationId, target.snapshot);
    if (count !== 1) return false;
    refreshDeletionOperation(client, operationId);
    return true;
  });
  if (!changed) throw new SonarrSeasonRecoveryConflictError('The Sonarr recovery target changed');
}

export async function retrySonarrSeasonReassignment(
  operationId: string,
  targetId: number,
  serverId: number,
): Promise<void> {
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    throw new SonarrSeasonRecoveryConflictError('Sonarr recovery target not found', 404);
  }
  const target = recoveryTarget(operationId, targetId, serverId);
  const validated = await validateDeletionTarget(serverId, target);
  const snapshot = validated.snapshot;
  if (
    target.targetKind !== 'episode_version' || snapshot.seasonCleanup !== true ||
    snapshot.seasonCoordinationOutcome !== 'automatic_adoption'
  ) {
    throw new SonarrSeasonRecoveryConflictError(
      'This target is not a failed Sonarr retained-version adoption',
    );
  }
  const persisted = snapshot.arrReassignments?.filter((entry) => entry.instanceType === 'sonarr');
  if (persisted?.length !== 1 || persisted[0]!.episodeId === null) {
    throw new SonarrSeasonRecoveryConflictError('Durable Sonarr recovery evidence is incomplete');
  }
  const reassignment = persisted[0]!;
  const episodeId = reassignment.episodeId!;
  const transition = reassignment.sonarrTransition;
  if (
    !transition || transition.oldFileRemovalConfirmedAt === undefined ||
    transition.adoptedMediaId !== undefined
  ) {
    throw new SonarrSeasonRecoveryConflictError(
      'Sonarr is not waiting for a fresh retained-version adoption attempt',
    );
  }
  if (!validated.live) {
    throw new SonarrSeasonRecoveryConflictError('The retained Plex episode is no longer available');
  }
  const retainedIds = new Set(
    snapshot.expectedRetainedVersions?.map((entry) => entry.mediaId) ?? [],
  );
  if (!validated.live.media.some((entry) => retainedIds.has(entry.mediaId))) {
    throw new SonarrSeasonRecoveryConflictError(
      'No authorized retained Plex version remains available',
    );
  }
  const targets = await getArrDeleteTargets(serverId, snapshot.libraryKey);
  assertAcceptedArrMappingsUnchanged(target.targetKind, snapshot, targets);
  const sonarr = targets.find((entry) =>
    entry.instanceType === 'sonarr' && entry.instanceId === reassignment.instanceId
  );
  if (!sonarr) {
    throw new SonarrSeasonRecoveryConflictError('The accepted Sonarr instance is unavailable');
  }
  const capabilities = await sonarr.client.sonarrSeasonCoordinationCapabilities();
  if (
    !capabilities.available || !capabilities.version ||
    capabilities.version !== snapshot.seasonSonarrVersion
  ) {
    throw new SonarrSeasonRecoveryConflictError(
      'The accepted Sonarr version changed or is outside the supported v4 baseline',
    );
  }
  const state = await sonarr.client.sonarrSeriesSnapshot(reassignment.recordId);
  const episode = state.episodes.find((entry) => entry.id === episodeId);
  if (
    !episode || episode.seriesId !== reassignment.recordId ||
    episode.seasonNumber !== snapshot.seasonIndex ||
    episode.episodeNumber !== snapshot.episodeIndex || episode.monitored !== false ||
    episode.episodeFileId !== 0 ||
    state.files.some((entry) => entry.episodeIds.includes(episodeId))
  ) {
    throw new SonarrSeasonRecoveryConflictError(
      'Sonarr is not in the exact protected and unadopted recovery state',
    );
  }
  await assertSonarrExactFileAbsent(sonarr.client, reassignment.managedPath);
  const commandIds = [transition.manualImportCommandId, transition.rescanCommandId].filter(
    (value): value is number => Number.isSafeInteger(value) && value! > 0,
  );
  for (const commandId of commandIds) {
    const command = await sonarr.client.sonarrCommand(commandId);
    if (
      command && !['completed', 'failed', 'aborted', 'cancelled'].includes(command.status)
    ) {
      throw new SonarrSeasonRecoveryConflictError(
        'A previous Sonarr reassignment command is still active',
      );
    }
  }
  const activity = await sonarr.client.sonarrSeriesActivity(
    reassignment.recordId,
    commandIds,
  );
  if (!activity.quiet) {
    throw new SonarrSeasonRecoveryConflictError(
      'Sonarr reassignment activity is not provably quiet',
    );
  }
  if (
    transition.rescanAttemptedAt !== undefined &&
    (!transition.rescanPreSnapshot ||
      !(transition.rescanAuthorizedChanges
        ? sonarrRescanHasOnlyAuthorizedChanges(
          transition.rescanPreSnapshot,
          state,
          transition.rescanAuthorizedChanges,
        )
        : sonarrRescanHasOnlyAuthorizedChange(
          transition.rescanPreSnapshot,
          state,
          episodeId,
          null,
        )))
  ) {
    throw new SonarrSeasonRecoveryConflictError(
      'The previous Sonarr rescan caused or cannot exclude collateral series changes; inspect Sonarr and request a fresh deletion preview',
    );
  }

  const next = structuredClone(snapshot);
  const nextTransition = next.arrReassignments?.find((entry) =>
    entry.instanceId === reassignment.instanceId
  )?.sonarrTransition;
  if (!nextTransition) {
    throw new SonarrSeasonRecoveryConflictError('Durable Sonarr recovery evidence is incomplete');
  }
  delete nextTransition.postDeletionPreflight;
  delete nextTransition.manualImportAttemptedAt;
  delete nextTransition.manualImportCommandId;
  delete nextTransition.manualImportRejectedAt;
  delete nextTransition.rescanAuthorizedAt;
  delete nextTransition.rescanPreSnapshot;
  delete nextTransition.rescanInventory;
  delete nextTransition.rescanAuthorizedChanges;
  delete nextTransition.rescanAttemptedAt;
  delete nextTransition.rescanCommandId;
  const now = Math.floor(Date.now() / 1000);
  const changed = withTransaction((client) => {
    const count = client.prepare(
      `UPDATE deletion_targets
       SET snapshot = ?, status = 'queued', attempt_count = 0, next_retry_at = NULL,
           error = NULL, updated_at = ?
       WHERE id = ? AND operation_id = ? AND status = 'needs_attention'
         AND phase = 'arr_coordination' AND snapshot = ?`,
    ).run(JSON.stringify(next), now, targetId, operationId, target.snapshot);
    if (count !== 1) return false;
    refreshDeletionOperation(client, operationId);
    return true;
  });
  if (!changed) throw new SonarrSeasonRecoveryConflictError('The Sonarr recovery target changed');
}
