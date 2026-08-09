import { withTransaction } from '../../../db/index.ts';
import { refreshDeletionOperation } from './state.ts';
import { DeletionConvergenceError, type DeletionPhase, type DeletionWorkTarget } from './types.ts';

export function advancePhase(target: DeletionWorkTarget, phase: DeletionPhase): void {
  const now = Math.floor(Date.now() / 1000);
  const changed = withTransaction((client) =>
    client.prepare(
      'UPDATE deletion_targets SET phase = ?, updated_at = ? WHERE id = ? AND status = ? AND phase = ?',
    ).run(phase, now, target.id, 'running', target.phase)
  );
  if (changed !== 1) throw new DeletionConvergenceError('deletion target state changed');
  target.phase = phase;
}

export function confirmReassignedRemoval(target: DeletionWorkTarget): void {
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

export function confirmRadarrPlexRemoval(
  target: DeletionWorkTarget,
  attributable: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  withTransaction((client) => {
    const changed = client.prepare(
      `UPDATE deletion_targets
       SET removal_confirmed_at = COALESCE(removal_confirmed_at, ?), updated_at = ?
       WHERE id = ? AND status = 'running' AND phase = 'arr_coordination'`,
    ).run(now, now, target.id);
    if (changed !== 1) throw new DeletionConvergenceError('deletion target state changed');
    if (attributable) {
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
    }
    refreshDeletionOperation(client, target.operationId);
  });
  target.removalConfirmedAt ??= now;
}

export function radarrLegacyAccountingIsAmbiguous(target: DeletionWorkTarget): boolean {
  if (target.removalConfirmedAt !== null) return true;
  return withTransaction((sqlite) =>
    sqlite.prepare(
      'SELECT 1 FROM media_removals WHERE operation_id = ? AND target_kind = ? AND target_key = ? LIMIT 1',
    ).value<[number]>(target.operationId, target.targetKind, target.targetKey) !== undefined
  );
}
