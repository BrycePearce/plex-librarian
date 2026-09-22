import { useEffect, useRef } from "react";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import type { DeletionOperation } from "@shared/types";
import { queryKeys } from "../../lib/queryKeys.ts";

export function useDeletionOutcomeRefresh(
  data: DeletionOperation | undefined,
  invalidateQueryKeys: QueryKey[],
) {
  const qc = useQueryClient();
  const lastOutcome = useRef<string | null>(null);
  // A sync can requeue and finish reconciliation between polls. Track target outcomes,
  // not just whether any terminal response has been seen, or a changing poll timestamp.
  const outcome = !data ? null : JSON.stringify([
    data.id,
    data.status,
    data.targets.map((target) => [
      target.id,
      target.status,
      target.status === "completed_with_warning" ? target.phase : null,
      target.removalConfirmedAt,
      target.plexReconciledAt,
      target.supersededReason,
      target.relocationGuidanceState,
      target.relocationSyncBarrierState,
    ]),
  ]);

  useEffect(() => {
    if (outcome === null) {
      lastOutcome.current = null;
      return;
    }
    if (lastOutcome.current === outcome) return;
    lastOutcome.current = outcome;
    for (const queryKey of deletionInsightQueryKeys(invalidateQueryKeys)) {
      void qc.invalidateQueries({ queryKey });
    }
  }, [outcome, invalidateQueryKeys, qc]);
}

// Ownership affects every cleanup surface, regardless of where deletion started.
export function deletionInsightQueryKeys(extra: QueryKey[]): QueryKey[] {
  const keys = [
    queryKeys.stale.all,
    queryKeys.duplicates.all,
    queryKeys.staleQuickCleanup.all,
    queryKeys.show.all,
    queryKeys.movie.all,
    queryKeys.libraries.all,
    ...extra,
  ];
  return keys.filter((key, index) =>
    keys.findIndex((other) => JSON.stringify(other) === JSON.stringify(key)) === index
  );
}
