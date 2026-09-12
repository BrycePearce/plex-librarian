import { useEffect, useRef } from "react";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import type { DeletionOperation } from "@shared/types";
import { activeDeletionStatuses } from "../../routes/-deletionOperationState.ts";

export function useDeletionOutcomeRefresh(
  data: DeletionOperation | undefined,
  invalidateQueryKeys: QueryKey[],
) {
  const qc = useQueryClient();
  const lastOutcome = useRef<string | null>(null);
  const active = !data || activeDeletionStatuses.has(data.status);
  // A sync can requeue and finish reconciliation between polls. Track target outcomes,
  // not just whether any terminal response has been seen, or a changing poll timestamp.
  const outcome = active ? null : JSON.stringify([
    data!.status,
    data!.targets.map((target) => [
      target.id,
      target.status,
      target.phase,
      target.removalConfirmedAt,
      target.plexReconciledAt,
      target.supersededReason,
    ]),
  ]);

  useEffect(() => {
    if (outcome === null) {
      lastOutcome.current = null;
      return;
    }
    if (lastOutcome.current === outcome) return;
    lastOutcome.current = outcome;
    for (const queryKey of invalidateQueryKeys) {
      void qc.invalidateQueries({ queryKey });
    }
  }, [outcome, invalidateQueryKeys, qc]);
}
