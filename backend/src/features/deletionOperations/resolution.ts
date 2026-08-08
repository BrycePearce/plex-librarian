import { withTransaction } from '../../db/index.ts';
import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';
import { radarrBytesMatchProjectedKilobytes } from '../mediaDeletion/radarrSize.ts';
import { revalidateArrReassignment } from './arrReassignment.ts';
import { refreshDeletionOperation } from './state.ts';
import type { DeletionWorkTarget } from './types.ts';
import { validateDeletionTarget } from './validation.ts';

export class ManagementHoldConflictError extends Error {
  constructor(message: string, readonly status: 404 | 409 = 409) {
    super(message);
  }
}

function samePath(left: string | null, right: string): boolean {
  return left !== null && normalizeRemoteAbsolute(left)?.comparison ===
      normalizeRemoteAbsolute(right)?.comparison;
}

export async function resolveRadarrManagementHold(
  operationId: string,
  serverId: number,
): Promise<'resumed' | 'cancelled'> {
  const row = withTransaction((client) =>
    client.prepare(
      `SELECT t.id, t.operation_id, o.server_id, t.target_kind, t.target_key, t.snapshot,
              t.logical_size, t.phase, t.removal_confirmed_at, t.plex_attempt_count
       FROM deletion_targets t
       JOIN deletion_operations o ON o.id = t.operation_id
       JOIN radarr_movie_reservations r ON r.target_id = t.id
       WHERE t.operation_id = ? AND o.server_id = ? AND t.status = 'needs_attention'
         AND r.state = 'management_hold'
         AND json_extract(t.snapshot, '$.resolutionState') = 'management_hold'`,
    ).value<unknown[]>(operationId, serverId)
  );
  if (!row) throw new ManagementHoldConflictError('management hold not found', 404);
  const target: DeletionWorkTarget = {
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
  const validated = await validateDeletionTarget(serverId, target);
  const snapshot = validated.snapshot;
  const persisted = snapshot.arrReassignments?.[0];
  const pathPlan = persisted?.radarrPathPlan;
  if (!persisted || !pathPlan || pathPlan.mode === 'existing_path') {
    throw new ManagementHoldConflictError('durable Radarr path-adoption evidence is missing');
  }
  const liveIds = new Set(validated.live?.media.map((entry) => entry.mediaId) ?? []);
  const entry = await revalidateArrReassignment(
    target,
    snapshot,
    validated.client,
    persisted.instanceId,
  );
  const adopted = samePath(entry.recordPath, pathPlan.targetMoviePath) &&
    samePath(entry.managedPath, pathPlan.retainedPath) &&
    entry.managedFileId !== null && entry.managedFileId !== pathPlan.originalMovieFile.id &&
    radarrBytesMatchProjectedKilobytes(entry.managedFileSize, persisted.retainedFileSize) &&
    liveIds.has(pathPlan.retainedMediaId);
  if (adopted) {
    withTransaction((client) => {
      const now = Math.floor(Date.now() / 1000);
      const changed = client.prepare(
        `UPDATE deletion_targets
         SET status = 'queued', next_retry_at = NULL, error = NULL,
             snapshot = json_remove(snapshot, '$.resolutionState'), updated_at = ?
         WHERE id = ? AND operation_id = ? AND status = 'needs_attention'
           AND json_extract(snapshot, '$.resolutionState') = 'management_hold'`,
      ).run(now, target.id, operationId);
      if (changed !== 1) throw new ManagementHoldConflictError('management hold changed');
      client.prepare(
        "UPDATE radarr_movie_reservations SET state = 'reserved', updated_at = ? WHERE target_id = ? AND state = 'management_hold'",
      ).run(now, target.id);
      refreshDeletionOperation(client, operationId);
    });
    return 'resumed';
  }

  const original = samePath(entry.recordPath, pathPlan.originalMoviePath) &&
    samePath(entry.managedPath, pathPlan.originalMovieFile.path) &&
    entry.managedFileId === pathPlan.originalMovieFile.id &&
    entry.managedFileSize === pathPlan.originalMovieFile.size &&
    liveIds.has(snapshot.mediaId!) && liveIds.has(pathPlan.retainedMediaId);
  if (!original) {
    throw new ManagementHoldConflictError(
      'Radarr is neither in the exact adopted target state nor the exact restored original state; the management hold remains active',
    );
  }
  if (snapshot.tmdbId === null) {
    throw new ManagementHoldConflictError('the durable Radarr movie identity is incomplete');
  }
  if (entry.monitored !== pathPlan.originalMonitored) {
    await entry.target.client.setRadarrMovieMonitored({
      movieId: pathPlan.movieId,
      tmdbId: snapshot.tmdbId,
      path: pathPlan.originalMoviePath,
    }, pathPlan.originalMonitored);
    const verified = await revalidateArrReassignment(
      target,
      snapshot,
      validated.client,
      persisted.instanceId,
    );
    if (verified.monitored !== pathPlan.originalMonitored) {
      throw new ManagementHoldConflictError('Radarr did not restore the original monitored state');
    }
  }
  withTransaction((client) => {
    const now = Math.floor(Date.now() / 1000);
    const changed = client.prepare(
      `UPDATE deletion_targets
       SET status = 'cancelled', next_retry_at = NULL, error = NULL,
           snapshot = json_remove(snapshot, '$.resolutionState'), updated_at = ?
       WHERE id = ? AND operation_id = ? AND status = 'needs_attention'
         AND json_extract(snapshot, '$.resolutionState') = 'management_hold'`,
    ).run(now, target.id, operationId);
    if (changed !== 1) throw new ManagementHoldConflictError('management hold changed');
    client.prepare('DELETE FROM media_version_reservations WHERE target_id = ?').run(target.id);
    client.prepare('DELETE FROM radarr_movie_reservations WHERE target_id = ?').run(target.id);
    refreshDeletionOperation(client, operationId);
  });
  return 'cancelled';
}
