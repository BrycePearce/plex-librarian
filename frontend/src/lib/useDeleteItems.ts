import { useMutation } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { api } from "./api.ts";
import { useDeletionOperationTracker } from "../features/deletionOperations/DeletionOperationCoordinator.tsx";

// Shared between the stale page's bulk whole-item delete and the duplicates page's
// "delete this movie entirely" escalation (see VersionPickerDialog) — both ultimately
// call the same whole-item-delete endpoint and need the same completion-time cache
// invalidation plumbing.
// `invalidateQueryKeys` is caller-supplied rather than a fixed list because the two
// pages don't actually invalidate the same query roots (duplicates.tsx additionally
// invalidates `duplicates`/`libraries`, which stale.tsx has no reason to touch).
export function useDeleteItems(invalidateQueryKeys: QueryKey[]) {
  const { trackDeletionOperation } = useDeletionOperationTracker();

  return useMutation({
    mutationFn: async (
      {
        libraryKey,
        ratingKeys,
        mode,
        cleanupDownloads,
        coordinatedRatingKeys,
        unmonitorRatingKeys,
      }: {
        libraryKey: string;
        ratingKeys: string[];
        mode?: "coordinated" | "plex-only";
        cleanupDownloads?: boolean;
        coordinatedRatingKeys?: string[];
        unmonitorRatingKeys?: string[];
      },
    ) => {
      const coordinated = coordinatedRatingKeys ??
        (mode === "coordinated" ? ratingKeys : []);
      return await api.libraries.deleteItems(
        libraryKey,
        ratingKeys,
        coordinated,
        cleanupDownloads,
        unmonitorRatingKeys,
      );
    },
    onSuccess: (result) => {
      trackDeletionOperation(result.operationId, invalidateQueryKeys);
    },
  });
}
