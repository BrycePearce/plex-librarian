import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { api } from "./api";
import type { DeleteItemsResponse } from "./api";
import { partitionDeletionRatingKeys } from "./deletionPlan.ts";

// Shared between the stale page's bulk whole-item delete and the duplicates page's
// "delete this movie entirely" escalation (see VersionPickerDialog) — both ultimately
// call the same whole-item-delete endpoint and need the same invalidation plumbing,
// even though the two pages' confirmation UI and result banners stay page-specific.
// `invalidateQueryKeys` is caller-supplied rather than a fixed list because the two
// pages don't actually invalidate the same query roots (duplicates.tsx additionally
// invalidates `duplicates`/`libraries`, which stale.tsx has no reason to touch).
export function useDeleteItems(invalidateQueryKeys: QueryKey[]) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (
      { libraryKey, ratingKeys, mode, cleanupDownloads, coordinatedRatingKeys }: {
        libraryKey: string;
        ratingKeys: string[];
        mode?: "coordinated" | "plex-only";
        cleanupDownloads?: boolean;
        coordinatedRatingKeys?: string[];
      },
    ) => {
      if (coordinatedRatingKeys === undefined) {
        if (mode === undefined) {
          throw new Error("Deletion mode must be selected explicitly");
        }
        return await api.libraries.deleteItems(
          libraryKey,
          ratingKeys,
          mode,
          cleanupDownloads,
        );
      }

      const { coordinated, plexOnly } = partitionDeletionRatingKeys(
        ratingKeys,
        coordinatedRatingKeys,
      );
      const results: DeleteItemsResponse[] = [];
      if (coordinated.length > 0) {
        results.push(
          await api.libraries.deleteItems(
            libraryKey,
            coordinated,
            "coordinated",
            cleanupDownloads,
          ),
        );
      }
      if (plexOnly.length > 0) {
        results.push(
          await api.libraries.deleteItems(libraryKey, plexOnly, "plex-only"),
        );
      }
      return {
        deleted: results.flatMap((result) => result.deleted),
        partial: results.flatMap((result) => result.partial),
        failed: results.flatMap((result) => result.failed),
        outcomes: results.flatMap((result) => result.outcomes),
      } satisfies DeleteItemsResponse;
    },
    onSuccess: () => {
      for (const queryKey of invalidateQueryKeys) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}
