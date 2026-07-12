import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ArrowLeft, BadgeCheck } from "lucide-react";
import { api } from "../lib/api";
import type { DuplicateGroup } from "../lib/api";
import { formatKilobytes } from "../lib/format";
import { useDeleteItems } from "../lib/useDeleteItems";
import { ErrorAlert } from "../components/ErrorAlert";
import { DeleteResultAlert } from "../components/DeleteResultAlert";
import { Pagination } from "../components/Pagination";
import { DuplicateGroupRow } from "./-duplicates/DuplicateGroupRow";
import { VersionPickerDialog } from "./-duplicates/VersionPickerDialog";
import { DuplicatesTableSkeleton } from "../components/Skeletons";
import { EmptyState } from "../components/EmptyState";
import { requireAuth } from "../lib/requireAuth";

const PAGE_SIZE = 50;

type TypeFilter = "all" | "movie" | "tv";

function validateDuplicatesSearch(
  search: Record<string, unknown>,
): { type: TypeFilter } {
  const type = search.type;
  return { type: type === "movie" || type === "tv" ? type : "all" };
}

export const Route = createFileRoute("/duplicates")({
  validateSearch: validateDuplicatesSearch,
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: DuplicatesPage,
});

function DuplicatesPage() {
  const { type } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();

  const [offset, setOffset] = useState(0);

  function setType(newType: TypeFilter) {
    setOffset(0);
    void navigate({ search: { type: newType }, replace: true });
  }

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["duplicates", { type, offset }],
    queryFn: () => api.duplicates.list({ type, limit: PAGE_SIZE, offset }),
    placeholderData: (prev) => prev,
  });

  const [reviewItem, setReviewItem] = useState<DuplicateGroup | null>(null);
  const [deleteResult, setDeleteResult] = useState<
    {
      mode: "versions" | "whole-item";
      title?: string;
      deletedCount: number;
      failedCount: number;
      fileSizeFreed: number;
      errors: string[];
    } | null
  >(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Both delete paths invalidate the same four query roots — the whole-item path
  // uses the shared hook (same endpoint the stale page's bulk delete calls), the
  // per-version path hits a different endpoint entirely so it invalidates directly.
  const deleteWholeItemMutation = useDeleteItems([
    ["duplicates"],
    ["stale"],
    ["libraries"],
    ["events"],
  ]);

  // Sequential, not concurrent — same "destructive and must stay attributable"
  // reasoning as the bulk stale-item delete flow.
  const deleteVersionsMutation = useMutation({
    mutationFn: async (
      { group, mediaIds }: { group: DuplicateGroup; mediaIds: number[] },
    ) => {
      let deletedCount = 0;
      let fileSizeFreed = 0;
      const errors: string[] = [];
      for (const mediaId of mediaIds) {
        try {
          const res = group.mediaType === "movie"
            ? await api.duplicates.deleteMovieMediaVersion(
              group.ratingKey,
              mediaId,
            )
            : await api.duplicates.deleteEpisodeMediaVersion(
              group.episodeRatingKey,
              mediaId,
            );
          deletedCount++;
          fileSizeFreed += res.fileSizeFreed;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : "Delete failed");
        }
      }
      return {
        mode: "versions" as const,
        deletedCount,
        failedCount: errors.length,
        fileSizeFreed,
        errors,
      };
    },
    onSuccess: (res) => {
      setDeleteResult(res);
      setReviewItem(null);
      dialogRef.current?.close();
      void qc.invalidateQueries({ queryKey: ["duplicates"] });
      void qc.invalidateQueries({ queryKey: ["stale"] });
      void qc.invalidateQueries({ queryKey: ["libraries"] });
      void qc.invalidateQueries({ queryKey: ["events"] });
    },
  });

  function handleConfirm(
    group: DuplicateGroup,
    mediaIds: number[],
    deleteWholeItem: boolean,
  ) {
    // Checking every version means "I don't want this at all" — hand off to the
    // same whole-item delete the stale page uses instead of deleting versions one
    // by one. Movies only: episodes have no whole-episode delete endpoint yet.
    if (deleteWholeItem && group.mediaType === "movie") {
      deleteWholeItemMutation.mutate(
        { libraryKey: group.libraryKey, ratingKeys: [group.ratingKey] },
        {
          onSuccess: (res) => {
            setDeleteResult({
              mode: "whole-item",
              title: group.title,
              deletedCount: res.deleted.length,
              failedCount: res.failed.length,
              // deleteItems doesn't return freed size per item; the group's own
              // combined size already reflects every version being removed.
              fileSizeFreed: res.deleted.length > 0
                ? (group.combinedFileSize ?? 0)
                : 0,
              errors: res.failed.map((f) => f.error),
            });
            setReviewItem(null);
            dialogRef.current?.close();
          },
        },
      );
      return;
    }
    deleteVersionsMutation.mutate({ group, mediaIds });
  }

  function openReview(item: DuplicateGroup) {
    setDeleteResult(null);
    setReviewItem(item);
    dialogRef.current?.showModal();
  }

  function closeReview() {
    dialogRef.current?.close();
  }

  const page = Math.floor(offset / PAGE_SIZE);
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/dashboard" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Duplicate Versions</h1>
          <p className="text-base-content/50 text-sm">
            {data
              ? `${data.total.toLocaleString()} with multiple synced versions`
              : 
              <span className="skeleton inline-block h-3 w-40 align-middle" />}
          </p>
        </div>
        <select
          className="select select-bordered select-sm"
          value={type}
          onChange={(e) => setType(e.target.value as TypeFilter)}
          aria-label="Filter by media type"
        >
          <option value="all">All</option>
          <option value="movie">Movies</option>
          <option value="tv">TV</option>
        </select>
      </div>

      {isError
        ? (
          <ErrorAlert
            message={error instanceof Error
              ? error.message
              : "Failed to load duplicates"}
            onRetry={() => void refetch()}
          />
        )
        : (
          <>
            {deleteResult && (
              <DeleteResultAlert
                variant={deleteResult.failedCount > 0 ? "warning" : "success"}
                onDismiss={() => setDeleteResult(null)}
              >
                {deleteResult.mode === "whole-item"
                  ? (
                    <>
                      Deleted "{deleteResult.title}" from Plex{" "}
                      ({formatKilobytes(deleteResult.fileSizeFreed)} freed).
                    </>
                  )
                  : (
                    <>
                      Deleted {deleteResult.deletedCount} version
                      {deleteResult.deletedCount === 1 ? "" : "s"}{" "}
                      ({formatKilobytes(deleteResult.fileSizeFreed)} freed).
                    </>
                  )}
                {deleteResult.failedCount > 0 && (
                  <>
                    {" "}
                    {deleteResult.failedCount} failed:{" "}
                    {deleteResult.errors.join("; ")}
                  </>
                )}
              </DeleteResultAlert>
            )}

            {isLoading
              ? <DuplicatesTableSkeleton />
              : data && data.groups.length === 0
              ? (
                <EmptyState
                  icon={BadgeCheck}
                  title="No duplicate versions"
                  description="Your library is tidy—there are no redundant synced versions in this view."
                />
              )
              : (
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Versions</th>
                        <th>Combined size</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data?.groups.map((item) => (
                        <DuplicateGroupRow
                          key={item.mediaType === "movie"
                            ? item.ratingKey
                            : item.episodeRatingKey}
                          item={item}
                          onReview={() => openReview(item)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={(p) => setOffset(p * PAGE_SIZE)}
            />
          </>
        )}

      <VersionPickerDialog
        dialogRef={dialogRef}
        item={reviewItem}
        pending={deleteWholeItemMutation.isPending ||
          deleteVersionsMutation.isPending}
        error={deleteWholeItemMutation.error ?? deleteVersionsMutation.error}
        onConfirm={(mediaIds, deleteWholeItem) =>
          reviewItem && handleConfirm(reviewItem, mediaIds, deleteWholeItem)}
        onCancel={closeReview}
      />
    </div>
  );
}
