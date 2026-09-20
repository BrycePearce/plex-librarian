import { currentLocationSnapshot, UPGRADE_RECOVERY_MESSAGE } from '../core/upgradePolicy.ts';
import { tryAcquireLibraryOperation } from '../../../services/libraryOperations.ts';
import { DeletionConvergenceError, type DeletionWorkTarget } from '../core/types.ts';
import type { DurableTargetSnapshot } from '../core/validation.ts';
import { ensureServiceOwnedDeletion } from './serviceOwnedWorkflow.ts';
import { ensureHistoricalDownloadPhase } from './historicalDownloadWorkflow.ts';

export async function ensureDeletionTarget(target: DeletionWorkTarget): Promise<void> {
  if (!currentLocationSnapshot(target.snapshot)) throw new Error(UPGRADE_RECOVERY_MESSAGE);
  const snapshot = JSON.parse(target.snapshot) as DurableTargetSnapshot;
  if (snapshot.serviceOwnedPlan?.policyVersion !== 4 || snapshot.upgradeHold !== undefined) {
    throw new Error(UPGRADE_RECOVERY_MESSAGE);
  }
  const release = tryAcquireLibraryOperation(target.serverId, snapshot.libraryKey, 'deletion');
  if (!release) throw new DeletionConvergenceError('the library is currently being modified');
  try {
    await ensureHistoricalDownloadPhase(target);
    await ensureServiceOwnedDeletion(target, snapshot);
  } finally {
    release();
  }
}
