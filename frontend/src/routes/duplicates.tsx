import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { BadgeCheck, Copy, HardDrive, Layers3, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import type { DuplicateGroup } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import { useDeleteItems } from "../lib/useDeleteItems";
import { ErrorAlert } from "../components/ErrorAlert";
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
import { InfoTip } from "../features/mediaDeletion/InfoTip";
import { normalizeSearchQuery } from "@shared/search";
import { useDeletionOperationTracker } from "../features/deletionOperations/DeletionOperationCoordinator";
import { formatKilobytes } from "../lib/format";
import { duplicatePageSummary } from "./-duplicates/duplicatePresentation";
import type { DuplicateComparisonFilter } from "@shared/mediaComparison";
import "./duplicates.css";

const PAGE_SIZE = 50;

type TypeFilter = "all" | "movie" | "tv";

function validateDuplicatesSearch(search: Record<string, unknown>): {
  type: TypeFilter;
  comparison: DuplicateComparisonFilter;
  search?: string;
} {
  const type = search.type;
  const comparison = search.comparison;
  return {
    type: type === "movie" || type === "tv" ? type : "all",
    comparison: comparison === "same-profile" || comparison === "different" ||
        comparison === "unknown"
      ? comparison
      : "all",
    search: normalizeSearchQuery(search.search),
  };
}

export const Route = createFileRoute("/duplicates")({
  validateSearch: validateDuplicatesSearch,
  search: {
    middlewares: [
      stripSearchParams({ type: "all", comparison: "all", search: "" }),
    ],
  },
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: DuplicatesPage,
});

function DuplicatesPage() {
  const { type, comparison, search = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { trackDeletionOperation } = useDeletionOperationTracker();

  const [offset, setOffset] = useState(0);

  function setType(newType: TypeFilter) {
    setOffset(0);
    void navigate({
      search: { type: newType, comparison, search },
      replace: true,
    });
  }

  function setComparison(newComparison: DuplicateComparisonFilter) {
    setOffset(0);
    void navigate({
      search: { type, comparison: newComparison, search },
      replace: true,
    });
  }

  function setSearch(newSearch: string) {
    setOffset(0);
    void navigate({
      search: { type, comparison, search: newSearch },
      replace: true,
    });
  }

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: queryKeys.duplicates.list({ type, comparison, search, offset }),
    queryFn: () =>
      api.duplicates.list({
        type,
        comparison,
        search,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: (prev) => prev,
  });

  const [reviewItem, setReviewItem] = useState<DuplicateGroup | null>(null);
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
      arrMediaIds,
      cleanupMediaIds,
      unmonitorFromArr,
    }: {
      group: DuplicateGroup;
      mediaIds: number[];
      arrMediaIds: number[];
      cleanupMediaIds: number[];
      unmonitorFromArr: boolean;
    }) => {
      if (group.mediaType === "movie") {
        return await api.duplicates.deleteMovieMediaVersions(
          group.ratingKey,
          mediaIds,
          arrMediaIds,
          cleanupMediaIds,
          unmonitorFromArr,
        );
      }
      return await api.duplicates.deleteEpisodeMediaVersions(
        group.episodeRatingKey,
        mediaIds,
        unmonitorFromArr,
      );
    },
    onSuccess: (res) => {
      trackDeletionOperation(res.operationId, [
        queryKeys.duplicates.all,
        queryKeys.stale.all,
        queryKeys.libraries.all,
        queryKeys.events.all,
        queryKeys.mediaRemovals.all,
        queryKeys.versionDeletionPreview.all,
      ]);
      setReviewItem(null);
      versionDialogRef.current?.close();
    },
  });

  function handleConfirm(
    group: DuplicateGroup,
    plan: {
      mediaIds: number[];
      deleteWholeItem: boolean;
      deleteFromArr: boolean;
      cleanupDownloads: boolean;
      arrMediaIds: number[];
      cleanupMediaIds: number[];
      unmonitorFromArr: boolean;
    },
  ) {
    // A fully selected movie normally uses the whole-item workflow. Mixed destination
    // support is the exception: Plex-only copies run first and the Radarr copy runs last.
    if (
      group.mediaType === "movie" &&
      versionDeletionExecutionTarget(group.mediaType, plan.deleteWholeItem) ===
        "whole-item" &&
      plan.arrMediaIds.length === 0
    ) {
      deleteWholeItemMutation.mutate(
        {
          libraryKey: group.libraryKey,
          ratingKeys: [group.ratingKey],
          coordinatedRatingKeys: [],
          cleanupDownloads: false,
          unmonitorRatingKeys: plan.unmonitorFromArr ? [group.ratingKey] : [],
        },
        {
          onSuccess: () => {
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
      arrMediaIds: plan.arrMediaIds,
      cleanupMediaIds: plan.cleanupMediaIds,
      unmonitorFromArr: plan.unmonitorFromArr,
    });
  }

  function openReview(item: DuplicateGroup) {
    setReviewItem(item);
    versionDialogRef.current?.showModal();
  }

  function closeReview() {
    versionDialogRef.current?.close();
  }

  const page = Math.floor(offset / PAGE_SIZE);
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
  const summary = duplicatePageSummary(data?.groups ?? []);

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
                    className="select select-bordered select-sm w-28 max-w-full"
                    value={type}
                    onChange={(e) => setType(e.target.value as TypeFilter)}
                    aria-label="Filter by media type"
                  >
                    <option value="all">All media</option>
                    <option value="movie">Movies</option>
                    <option value="tv">TV</option>
                  </select>
                  <span className="duplicates-comparison-filter inline-flex items-center gap-1.5">
                    <select
                      className="select select-bordered select-sm w-44 max-w-full"
                      value={comparison}
                      onChange={(e) =>
                        setComparison(
                          e.target.value as DuplicateComparisonFilter,
                        )}
                      aria-label="Filter by technical comparison"
                    >
                      <option value="all">All comparisons</option>
                      <option value="same-profile">
                        Same technical profile
                      </option>
                      <option value="different">Meaningful differences</option>
                      <option value="unknown">Needs review</option>
                    </select>
                    <InfoTip text="Compares Plex-reported resolution, codec, HDR, and audio/subtitle tracks across a group's versions. “Same technical profile” means those fields match, not that the files are byte-identical. “Needs review” means Plex didn't report enough fields to compare." />
                  </span>
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

            {data && data.groups.length > 0 && (
              <section
                className="duplicates-summary"
                aria-label="Duplicate storage summary"
              >
                <div className="duplicates-summary-card">
                  <span className="duplicates-summary-icon">
                    <Layers3 className="size-4" />
                  </span>
                  <span className="duplicates-summary-copy">
                    <span>Versions on this page</span>
                    <strong>{summary.versionCount.toLocaleString()}</strong>
                  </span>
                </div>
                <div className="duplicates-summary-card">
                  <span className="duplicates-summary-icon">
                    <HardDrive className="size-4" />
                  </span>
                  <span className="duplicates-summary-copy">
                    <span>Storage on this page</span>
                    <strong>
                      {summary.storageKilobytes != null
                        ? formatKilobytes(summary.storageKilobytes)
                        : "Unknown"}
                    </strong>
                  </span>
                </div>
                <div className="duplicates-summary-card duplicates-summary-card-featured">
                  <span className="duplicates-summary-icon">
                    <Sparkles className="size-4" />
                  </span>
                  <span className="duplicates-summary-copy">
                    <span>Extra copies on page · largest kept</span>
                    <strong>
                      {summary.reclaimableKilobytes != null
                        ? formatKilobytes(summary.reclaimableKilobytes)
                        : "Unknown"}
                    </strong>
                  </span>
                </div>
              </section>
            )}

            {isLoading
              ? <DuplicatesTableSkeleton />
              : data && data.groups.length === 0
              ? (
                <EmptyState
                  icon={BadgeCheck}
                  title={search || comparison !== "all"
                    ? "No matching duplicate titles"
                    : "No duplicate versions"}
                  description={comparison !== "all"
                    ? "No duplicate groups match the selected filters."
                    : search
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
                        <th>Storage footprint</th>
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
