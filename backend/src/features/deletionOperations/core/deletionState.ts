import { withTransaction } from '../../../db/index.ts';

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
