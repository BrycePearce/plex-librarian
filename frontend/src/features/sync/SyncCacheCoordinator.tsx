import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import { invalidateSyncDerivedQueries } from "../../lib/queryCache.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { useSyncStream } from "../../lib/useSyncStream.ts";
import {
  initialSyncCacheLifecycleState,
  observeGlobalSyncHistory,
  observeGlobalSyncStream,
} from "./syncCacheLifecycle.ts";

// Owns the cache side effects of a global sync independently of whichever page happens
// to be mounted. This is intentionally a headless feature component.
export function SyncCacheCoordinator() {
  const queryClient = useQueryClient();
  const { data: history } = useQuery({
    queryKey: queryKeys.sync.history,
    queryFn: () => api.sync.history(10),
    // Scheduler-started runs have no frontend mutation to invalidate this query. Polling
    // also catches a small run that starts and finishes between two observations.
    refetchInterval: 30_000,
  });
  const latestGlobalSync = history?.find((sync) => sync.libraryKey === null) ??
    (history === undefined ? undefined : null);
  const syncId = latestGlobalSync?.status === "pending" ? latestGlobalSync.id : null;
  const { isDone, error } = useSyncStream(syncId);
  const lifecycle = useRef(initialSyncCacheLifecycleState);

  useEffect(() => {
    const transition = observeGlobalSyncHistory(
      lifecycle.current,
      latestGlobalSync,
    );
    lifecycle.current = transition.state;
    if (transition.shouldInvalidate) {
      void invalidateSyncDerivedQueries(queryClient);
    }
  }, [latestGlobalSync, queryClient]);

  useEffect(() => {
    const transition = observeGlobalSyncStream(
      lifecycle.current,
      syncId,
      isDone,
      error,
    );
    lifecycle.current = transition.state;
    if (transition.shouldInvalidate) {
      void invalidateSyncDerivedQueries(queryClient);
    }
  }, [syncId, isDone, error, queryClient]);

  return null;
}
