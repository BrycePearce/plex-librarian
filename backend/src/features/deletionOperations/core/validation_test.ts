import { assertThrows } from '@std/assert';
import {
  DeletionValidationError,
  type DurableTargetSnapshot,
  validateArrMonitoringEvidence,
} from './validation.ts';
import { UPGRADE_RECOVERY_MESSAGE } from './upgradePolicy.ts';

Deno.test('deletion validation rejects snapshots without current service-owned evidence', () => {
  for (
    const snapshot of [{}, { ordinaryPlan: { policyVersion: 2 } }, { versionStorageEvidence: {} }]
  ) {
    assertThrows(
      () => validateArrMonitoringEvidence(snapshot as DurableTargetSnapshot),
      DeletionValidationError,
      UPGRADE_RECOVERY_MESSAGE,
    );
  }
});
