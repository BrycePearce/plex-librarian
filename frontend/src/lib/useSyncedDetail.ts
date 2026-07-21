import { useQuery } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { isNotFoundError } from "./api";
import { useSyncHistory } from "./useLibrarySync";
import { useNotSyncedYet } from "./useNotSyncedYet";

/**
 * Detail rows may legitimately 404 while their first full sync is still importing.
 * This keeps the retry/polling policy identical for movie and show detail pages while
 * leaving their data fetching and presentation strongly typed and route-specific.
 */
export function useSyncedDetail<T>(
  queryKey: QueryKey,
  queryFn: () => Promise<T>,
) {
  const { data: history, isLoading: isHistoryLoading } = useSyncHistory();
  const anySyncPending = history?.some((entry) => entry.status === "pending") ??
    false;
  const syncMightResolveThis = anySyncPending || isHistoryLoading;

  const query = useQuery({
    queryKey,
    queryFn,
    retry: (failureCount, error) => !isNotFoundError(error) && failureCount < 2,
    refetchInterval: (result) =>
      isNotFoundError(result.state.error) && syncMightResolveThis ? 4_000 : false,
  });

  const isNotFoundYet = useNotSyncedYet(
    query.isError,
    query.error,
    syncMightResolveThis,
  );

  return { ...query, isNotFoundYet };
}
