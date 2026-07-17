import type { QueryClient } from "@tanstack/react-query";
import { serverScopedQueryRoots, syncDerivedQueryRoots } from "./queryKeys.ts";

// A server switch must clear data instead of briefly rendering the prior server's cache.
export function resetServerScopedQueries(
  queryClient: QueryClient,
): Promise<void> {
  return queryClient.resetQueries({
    predicate: (query) =>
      serverScopedQueryRoots.some((root) => query.queryKey[0] === root),
  });
}

// Mark both mounted and previously visited sync-derived views stale. Mounted queries
// refetch immediately; inactive ones refetch when the user returns to them.
export async function invalidateSyncDerivedQueries(
  queryClient: QueryClient,
): Promise<void> {
  await Promise.all(
    syncDerivedQueryRoots.map((root) =>
      queryClient.invalidateQueries({ queryKey: [root] })
    ),
  );
}
