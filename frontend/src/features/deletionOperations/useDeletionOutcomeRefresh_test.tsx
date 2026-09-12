import { assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import type { DeletionOperation, DeletionOperationTarget } from "@shared/types";
import { useDeletionOutcomeRefresh } from "./useDeletionOutcomeRefresh.ts";

const target: DeletionOperationTarget = {
  relocationGuidanceState: "none",
  relocationSyncBarrierState: "none",
  id: 1,
  ordinal: 0,
  targetKind: "movie_version",
  targetKey: "movie:11",
  title: "Movie",
  status: "needs_attention",
  attemptCount: 1,
  phase: "plex_reconciliation",
  removalConfirmedAt: null,
  plexReconciledAt: null,
  plexAttemptCount: 1,
  warning: null,
  downloadCleanupSelected: false,
  arrCoordinationConfigured: false,
  nextRetryAt: null,
  error: "Plex reconciliation could not be confirmed",
  logicalSize: 100,
  supersededReason: null,
};

const operation: DeletionOperation = {
  id: "operation",
  clientRequestId: "request",
  libraryKey: "movies",
  kind: "movie_version",
  status: "needs_attention",
  targetCount: 1,
  completedCount: 0,
  warningCount: 0,
  cancelledCount: 0,
  supersededCount: 0,
  libraryRecoveryTargetCount: 0,
  removalConfirmedCount: 0,
  failedCount: 1,
  logicalSizeRemoved: 0,
  nextRetryAt: null,
  createdAt: 1,
  startedAt: 1,
  finishedAt: 2,
  updatedAt: 2,
  targets: [target],
};

for (const initialStatus of ["needs_attention", "completed_with_warning"] as const) {
  Deno.test(`terminal ${initialStatus} refreshes again after reconciliation between polls`, async () => {
    const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prior = globals.IS_REACT_ACT_ENVIRONMENT;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const listKeys = [["duplicates"], ["stale", "movies"]];
    for (const key of listKeys) client.setQueryData(key, ["selected version"]);
    const invalidations: unknown[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "invalidate") {
        invalidations.push(event.query.queryKey);
      }
    });
    function Observer({ data }: { data: DeletionOperation }) {
      useDeletionOutcomeRefresh(data, listKeys);
      return null;
    }
    const render = (data: DeletionOperation) => (
      <QueryClientProvider client={client}>
        <Observer data={data} />
      </QueryClientProvider>
    );
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    try {
      const initial = {
        ...operation,
        status: initialStatus,
        targets: [{ ...target, status: initialStatus }],
      };
      await act(() => {
        renderer = TestRenderer.create(render(initial));
      });
      assertEquals(invalidations, listKeys);
      // Simulate the lists finishing their first refresh, then an identical later poll.
      for (const key of listKeys) client.setQueryData(key, ["selected version"]);
      await act(() => {
        renderer!.update(render({ ...initial, updatedAt: 3 }));
      });
      assertEquals(invalidations.length, 2);
      const completed: DeletionOperation = {
        ...initial,
        status: "completed",
        completedCount: 1,
        failedCount: 0,
        removalConfirmedCount: 1,
        logicalSizeRemoved: 100,
        updatedAt: 4,
        targets: [{
          ...target,
          status: "completed",
          phase: "finalizing",
          removalConfirmedAt: 4,
          plexReconciledAt: 4,
        }],
      };
      await act(() => {
        renderer!.update(render(completed));
      });
      assertEquals(invalidations, [...listKeys, ...listKeys]);
      for (const key of listKeys) client.setQueryData(key, []);
      await act(() => {
        renderer!.update(render({ ...completed, updatedAt: 5 }));
      });
      assertEquals(invalidations.length, 4);
    } finally {
      if (renderer) await act(() => renderer!.unmount());
      unsubscribe();
      client.clear();
      globals.IS_REACT_ACT_ENVIRONMENT = prior;
    }
  });
}
