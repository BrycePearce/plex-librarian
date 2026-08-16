// Persists narrowly scoped Sonarr transition changes with the workflow's existing CAS contract.
import { withTransaction } from '../../../db/index.ts';
import type { PersistedArrReassignment } from '../../mediaDeletion/arrReassignmentPlanning/types.ts';
import { DeletionConvergenceError, type DeletionWorkTarget } from '../core/types.ts';
import type { DurableTargetSnapshot } from '../core/validation.ts';

export function persistSonarrTransition(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  instanceId: number,
  update: (entry: PersistedArrReassignment) => void,
): void {
  const current = withTransaction((db) =>
    db.prepare(
      "SELECT snapshot FROM deletion_targets WHERE id = ? AND status IN ('queued', 'running')",
    ).value<[string]>(target.id)?.[0]
  );
  if (!current) throw new DeletionConvergenceError('Could not read durable Sonarr progress');
  const next = JSON.parse(current) as DurableTargetSnapshot;
  const entry = next.arrReassignments?.find((candidate) => candidate.instanceId === instanceId);
  if (!entry?.sonarrTransition) throw new Error('The durable Sonarr transition is incomplete');
  update(entry);
  const changed = withTransaction((db) =>
    db.prepare(
      "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running') AND snapshot = ?",
    ).run(JSON.stringify(next), Math.floor(Date.now() / 1000), target.id, current)
  );
  if (changed !== 1) throw new DeletionConvergenceError('Could not persist Sonarr progress');
  for (const key of Object.keys(snapshot)) {
    delete (snapshot as unknown as Record<string, unknown>)[key];
  }
  Object.assign(snapshot, next);
  target.snapshot = JSON.stringify(next);
}
