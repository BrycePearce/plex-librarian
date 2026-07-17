import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { BadgeCheck, Copy } from "lucide-react";
import { api } from "../lib/api";
import type { DuplicateGroup } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import { formatKilobytes } from "../lib/format";
import { useDeleteItems } from "../lib/useDeleteItems";
import { ErrorAlert } from "../components/ErrorAlert";
import { DeleteResultAlert } from "../components/DeleteResultAlert";
import { Pagination } from "../components/Pagination";
import { DuplicateGroupRow } from "./-duplicates/DuplicateGroupRow";
import { VersionPickerDialog } from "./-duplicates/VersionPickerDialog";
import { versionDeletionExecutionTarget } from "./-duplicates/versionDeletionState";
import { DuplicatesTableSkeleton } from "../components/Skeletons";
import { EmptyState } from "../components/EmptyState";
import { requireAuth } from "../lib/requireAuth";
import {
  CollectionToolbar,
  DataSurface,
  PageHeader,
} from "../components/Workspace";
import { ExpandableSearch } from "../components/ExpandableSearch";
import { normalizeSearchQuery } from "@shared/search";

const PAGE_SIZE = 50;

type TypeFilter = "all" | "movie" | "tv";

function validateDuplicatesSearch(search: Record<string, unknown>): {
  type: TypeFilter;
  search?: string;
} {
  const type = search.type;
  return {
    type: type === "movie" || type === "tv" ? type : "all",
    search: normalizeSearchQuery(search.search),
  };
}

export const Route = createFileRoute("/duplicates")({
  validateSearch: validateDuplicatesSearch,
  search: {
    middlewares: [stripSearchParams({ type: "all", search: "" })],
  },
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: DuplicatesPage,
});

function DuplicatesPage() {
  const { type, search = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();

  const [offset, setOffset] = useState(0);

  function setType(newType: TypeFilter) {
    setOffset(0);
    void navigate({ search: { type: newType, search }, replace: true });
  }

  function setSearch(newSearch: string) {
    setOffset(0);
    void navigate({ search: { type, search: newSearch }, replace: true });
  }

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: queryKeys.duplicates.list({ type, search, offset }),
    queryFn: () =>
      api.duplicates.list({ type, search, limit: PAGE_SIZE, offset }),
    placeholderData: (prev) => prev,
  });

  const [reviewItem, setReviewItem] = useState<DuplicateGroup | null>(null);
  const [deleteResult, setDeleteResult] = useState<
    {
      mode: "versions" | "whole-item";
      title?: string;
      deletedCount: number;
      partialCount: number;
      failedCount: number;
      fileSizeFreed: number;
      errors: string[];
      completedStages: string[];
    } | null
  >(null);
  const versionDialogRef = useRef<HTMLDialogElement>(null);

  // Both delete paths invalidate the same four query roots — the whole-item path
  // uses the shared hook (same endpoint the stale page's bulk delete calls), the
  // per-version path hits a different endpoint entirely so it invalidates directly.
  const deleteWholeItemMutation = useDeleteItems([
    queryKeys.duplicates.all,
    queryKeys.stale.all,
    queryKeys.libraries.all,
    queryKeys.events.all,
    queryKeys.mediaRemovals.all,
  ]);

  // Sequential, not concurrent — same "destructive and must stay attributable"
  // reasoning as the bulk stale-item delete flow.
  const deleteVersionsMutation = useMutation({
    mutationFn: async ({
      group,
      mediaIds,
      deleteFromArr,
      cleanupDownloads,
    }: {
      group: DuplicateGroup;
      mediaIds: number[];
      deleteFromArr: boolean;
      cleanupDownloads: boolean;
    }) => {
      if (group.mediaType === "movie") {
        const response = await api.duplicates.deleteMovieMediaVersions(
          group.ratingKey,
          mediaIds,
          deleteFromArr,
          cleanupDownloads,
        );
        return {
          mode: "versions" as const,
          deletedCount: response.deletedMediaIds.length,
          partialCount:
            response.deletedMediaIds.length > 0 && response.failed.length > 0
              ? 1
              : 0,
          failedCount: response.failed.length,
          fileSizeFreed: response.fileSizeFreed,
          errors: response.failed.map((failure) => failure.error),
          completedStages: response.outcomes
            .filter((stage) => stage.status !== "failed")
            .map((stage) => `${stage.system} (${stage.target})`),
        };
      }
      let deletedCount = 0;
      let fileSizeFreed = 0;
      const errors: string[] = [];
      for (const mediaId of mediaIds) {
        try {
          const res = await api.duplicates.deleteEpisodeMediaVersion(
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
        partialCount: 0,
        failedCount: errors.length,
        fileSizeFreed,
        errors,
        completedStages: [],
      };
    },
    onSuccess: (res) => {
      setDeleteResult(res);
      setReviewItem(null);
      versionDialogRef.current?.close();
      void qc.invalidateQueries({ queryKey: queryKeys.duplicates.all });
      void qc.invalidateQueries({ queryKey: queryKeys.stale.all });
      void qc.invalidateQueries({ queryKey: queryKeys.libraries.all });
      void qc.invalidateQueries({ queryKey: queryKeys.events.all });
      void qc.invalidateQueries({ queryKey: queryKeys.mediaRemovals.all });
      void qc.invalidateQueries({
        queryKey: queryKeys.versionDeletionPreview.all,
      });
    },
  });

  function handleConfirm(
    group: DuplicateGroup,
    plan: {
      mediaIds: number[];
      deleteWholeItem: boolean;
      deleteFromArr: boolean;
      cleanupDownloads: boolean;
    },
  ) {
    // Every selected movie version is a whole-title deletion, but it stays in this
    // review dialog. The warning and destination choices above are the confirmation;
    // execution uses the established whole-item endpoint so Plex is never asked to
    // remove the final Media entry through the version endpoint.
    if (
      versionDeletionExecutionTarget(group.mediaType, plan.deleteWholeItem) ===
        "whole-item"
    ) {
      deleteWholeItemMutation.mutate(
        {
          libraryKey: group.libraryKey,
          ratingKeys: [group.ratingKey],
          coordinatedRatingKeys: plan.deleteFromArr ? [group.ratingKey] : [],
          cleanupDownloads: plan.deleteFromArr && plan.cleanupDownloads,
        },
        {
          onSuccess: (res) => {
            setDeleteResult({
              mode: "whole-item",
              title: group.title,
              deletedCount: res.deleted.length,
              partialCount: res.partial.length,
              failedCount: res.failed.length,
              fileSizeFreed: res.deleted.length > 0
                ? (group.combinedFileSize ?? 0)
                : 0,
              errors: [
                ...res.partial.flatMap((partial) =>
                  partial.failedInstances.map((instance) =>
                    `${instance.instanceName}: ${instance.error}`
                  )
                ),
                ...res.failed.map((failure) => failure.error),
              ],
              completedStages: res.outcomes.flatMap((outcome) =>
                outcome.stages
                  .filter((stage) =>
                    stage.system !== "local" &&
                    (stage.status === "deleted" ||
                      stage.status === "already-absent")
                  )
                  .map((stage) => `${stage.system} (${stage.target})`)
              ),
            });
            setReviewItem(null);
            versionDialogRef.current?.close();
          },
        },
      );
      return;
    }
    deleteVersionsMutation.mutate({
      group,
      mediaIds: plan.mediaIds,
      deleteFromArr: plan.deleteFromArr,
      cleanupDownloads: plan.cleanupDownloads,
    });
  }

  function openReview(item: DuplicateGroup) {
    setDeleteResult(null);
    setReviewItem(item);
    versionDialogRef.current?.showModal();
  }

  function closeReview() {
    versionDialogRef.current?.close();
  }

  const page = Math.floor(offset / PAGE_SIZE);
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="workspace-page workspace-tone-accent space-y-6">
      <div className="workspace-sticky-header sticky top-0 z-20">
        <PageHeader
          eyebrow="Storage intelligence"
          title="Duplicate versions"
          icon={Copy}
          tone="accent"
          description={data
            ? (
              `${data.total.toLocaleString()} with multiple synced versions`
            )
            : <span className="skeleton inline-block h-3 w-40 align-middle" />}
        />
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
                variant={deleteResult.failedCount > 0 ||
                    deleteResult.partialCount > 0
                  ? "warning"
                  : "success"}
                autoDismiss={deleteResult.failedCount === 0 &&
                  deleteResult.partialCount === 0}
                onDismiss={() => setDeleteResult(null)}
              >
                {deleteResult.mode === "whole-item" &&
                  deleteResult.partialCount > 0 && (
                  <>
                    Partially deleted "{deleteResult.title}" from its mapped
                    media managers. Retry to reconcile the remaining instances.
                  </>
                )}
                {deleteResult.mode === "whole-item" &&
                  deleteResult.partialCount === 0 &&
                  deleteResult.deletedCount === 0 && (
                  <>Could not delete "{deleteResult.title}".</>
                )}
                {deleteResult.mode === "whole-item" &&
                  deleteResult.deletedCount > 0 && (
                  <>
                    Removed "{deleteResult.title}" from its selected
                    destinations (
                    {formatKilobytes(deleteResult.fileSizeFreed)} freed).
                  </>
                )}
                {deleteResult.mode === "versions" && (
                  <>
                    Deleted {deleteResult.deletedCount} version
                    {deleteResult.deletedCount === 1 ? "" : "s"} (
                    {formatKilobytes(deleteResult.fileSizeFreed)} freed).
                  </>
                )}
                {deleteResult.errors.length > 0 && (
                  <>
                    {" "}
                    Details: {deleteResult.errors.join("; ")}
                  </>
                )}
                {deleteResult.completedStages.length > 0 &&
                  deleteResult.errors.length > 0 && (
                  <>
                    Already completed:{" "}
                    {deleteResult.completedStages.join(", ")}.
                  </>
                )}
              </DeleteResultAlert>
            )}

            <CollectionToolbar
              eyebrow="Content review"
              title="Duplicate groups"
              actions={
                <>
                  <ExpandableSearch
                    search={search}
                    pending={isFetching}
                    onSearchChange={setSearch}
                    label="Search duplicate titles"
                    placeholder="Search movies, shows, or episodes..."
                  />
                  <select
                    className="select select-bordered select-sm"
                    value={type}
                    onChange={(e) => setType(e.target.value as TypeFilter)}
                    aria-label="Filter by media type"
                  >
                    <option value="all">All media</option>
                    <option value="movie">Movies</option>
                    <option value="tv">TV</option>
                  </select>
                </>
              }
              meta={data
                ? search
                  ? `${data.total.toLocaleString()} match${
                    data.total === 1 ? "" : "es"
                  }`
                  : `${data.total.toLocaleString()} groups`
                : undefined}
            />

            {isLoading
              ? <DuplicatesTableSkeleton />
              : data && data.groups.length === 0
              ? (
                <EmptyState
                  icon={BadgeCheck}
                  title={search
                    ? "No matching duplicate titles"
                    : "No duplicate versions"}
                  description={search
                    ? `No duplicate movies, shows, or episodes match “${search}”.`
                    : "Your library is tidy—there are no redundant synced versions in this view."}
                />
              )
              : (
                <DataSurface className="overflow-x-auto">
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
                </DataSurface>
              )}

            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={(p) => setOffset(p * PAGE_SIZE)}
            />
          </>
        )}

      <VersionPickerDialog
        dialogRef={versionDialogRef}
        item={reviewItem}
        pending={deleteVersionsMutation.isPending ||
          deleteWholeItemMutation.isPending}
        error={deleteVersionsMutation.error ?? deleteWholeItemMutation.error}
        onConfirm={(plan) => reviewItem && handleConfirm(reviewItem, plan)}
        onCancel={closeReview}
      />
    </div>
  );
}
