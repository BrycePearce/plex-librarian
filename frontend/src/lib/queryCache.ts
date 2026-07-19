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

// Disconnect is different from a server switch: by the time this runs the protected
// layout has been replaced by setup. Cancel any stragglers and remove their data
// without making mounted queries refetch against a server that is no longer active.
export async function clearServerScopedQueries(
  queryClient: QueryClient,
): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }) =>
    serverScopedQueryRoots.some((root) => query.queryKey[0] === root);

  await queryClient.cancelQueries({ predicate });
  queryClient.removeQueries({ predicate });
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
