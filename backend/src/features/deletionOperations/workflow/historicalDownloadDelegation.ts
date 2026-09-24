import type { SqliteClient } from '../../../db/index.ts';
import type { HistoricalDownloadPreview } from '../../../../../shared/historicalDownloads.ts';
import type { DurableTargetSnapshot } from '../core/validation.ts';
import {
  serviceOwnedFingerprint,
  type ServiceOwnedPlan,
} from '../../mediaDeletion/serviceOwnedPlanning.ts';

type Target = { id: number; snapshot: DurableTargetSnapshot };
export interface HistoricalDelegation {
  version: 1;
  kind: 'qb_delegation';
  evidenceFingerprint: string;
  path: string;
  actions: Array<{ targetId: number; actionId: string; fingerprint: string }>;
}

/** Called only with fresh exact-path coverage, before any service mutation. */
export function historicalDelegation(
  evidence: unknown,
  path: string,
  owners: Array<{ instanceId: number; lineage: { source: string } }>,
  coverage: HistoricalDownloadPreview['handled'],
  targets: Target[],
  freshPlans: readonly ServiceOwnedPlan[],
): HistoricalDelegation | undefined {
  const matches = owners.map((owner) =>
    coverage?.find((c) =>
      c.instanceId === owner.instanceId && c.source === owner.lineage.source && c.path === path
    )
  );
  if (!matches.length || matches.some((c) => !c?.actionIds.length)) return;
  const actions: HistoricalDelegation['actions'] = [];
  for (const actionId of new Set(matches.flatMap((c) => c!.actionIds))) {
    let found = false;
    for (const target of targets) {
      const plan = target.snapshot.serviceOwnedPlan;
      const action = plan?.actions.find((a) => a.id === actionId);
      if (!action) continue;
      const fresh = freshPlans.flatMap((p) => p.actions.filter((a) => a.id === actionId));
      if (
        !fresh.length ||
        fresh.some((a) => serviceOwnedFingerprint(a) !== serviceOwnedFingerprint(action))
      ) return;
      const decision = plan!.retention.decisions.find((d) => d.actionId === actionId);
      if (
        target.snapshot.upgradeHold !== undefined || !plan!.qbSelected ||
        action.service !== 'qb' || action.presence !== 'current' || !action.effectsComplete ||
        action.retainedOwnership || !decision?.requested || decision.state !== 'delete_candidate'
      ) return;
      found = true;
      actions.push({ targetId: target.id, actionId, fingerprint: serviceOwnedFingerprint(action) });
    }
    if (!found) return;
  }
  return {
    version: 1,
    kind: 'qb_delegation',
    evidenceFingerprint: serviceOwnedFingerprint(evidence),
    path,
    actions,
  };
}

/** Accounting only: no inventory requests, local fallback, or destructive replay.
 * Runs in the same transaction as the service outcome checkpoint. Legacy rows
 * without explicit delegation evidence are never inferred from reason strings. */
export function reconcileHistoricalDelegations(db: SqliteClient, operationId: string): void {
  const rows = db.prepare(
    "SELECT id,evidence,validation FROM historical_download_journal WHERE operation_id=? AND status='skipped' AND validation IS NOT NULL",
  ).values<[string, string, string]>(operationId);
  if (!rows.length) return;
  const targets = new Map(
    db.prepare('SELECT id,snapshot FROM deletion_targets WHERE operation_id=?')
      .values<[number, string]>(operationId).map((
        [id, raw],
      ) => [id, JSON.parse(raw) as DurableTargetSnapshot]),
  );
  for (const [id, raw, validation] of rows) {
    let link: HistoricalDelegation;
    try {
      link = JSON.parse(validation);
      const evidence = JSON.parse(raw);
      if (
        link.version !== 1 || link.kind !== 'qb_delegation' ||
        link.evidenceFingerprint !== serviceOwnedFingerprint(evidence) ||
        link.path !== (evidence.discovery === 1 ? evidence.path : evidence.filesystem?.path) ||
        !Array.isArray(link.actions) || !link.actions.length ||
        link.actions.some((ref) =>
          !ref || !Number.isSafeInteger(ref.targetId) || ref.targetId <= 0 ||
          typeof ref.actionId !== 'string' || typeof ref.fingerprint !== 'string'
        )
      ) continue;
    } catch {
      continue;
    }
    if (
      !link.actions.every((ref) => {
        const snapshot = targets.get(ref.targetId);
        const plan = snapshot?.serviceOwnedPlan;
        const action = plan?.actions.find((a) => a.id === ref.actionId);
        const decision = plan?.retention.decisions.find((d) => d.actionId === ref.actionId);
        const attempt = snapshot?.serviceOwnedAttempts?.[ref.actionId];
        return snapshot?.upgradeHold === undefined && plan?.qbSelected &&
          action?.service === 'qb' && action.effectsComplete && !action.retainedOwnership &&
          decision?.requested && decision.state === 'delete_candidate' &&
          serviceOwnedFingerprint(action) === ref.fingerprint &&
          !!attempt?.response && ['accepted', 'succeeded'].includes(attempt.response.status) &&
          attempt.response.httpStatus >= 200 && attempt.response.httpStatus < 300 &&
          !attempt.error && !attempt.failure &&
          attempt.outcome?.status === 'target_absent' &&
          attempt.outcome.observedAt >= attempt.startedAt;
      })
    ) continue;
    db.prepare(
      "UPDATE historical_download_journal SET status='handled_by_qb',reason=NULL,finished_at=? WHERE id=? AND status='skipped'",
    )
      .run(Date.now(), id);
  }
}
