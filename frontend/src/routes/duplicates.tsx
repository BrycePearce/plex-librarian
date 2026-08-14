import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { BadgeCheck, Copy, HardDrive, Layers3, Sparkles } from "lucide-react";
import { api } from "../lib/api.ts";
import type { DuplicateGroup, DuplicateSeasonGroup } from "../lib/api.ts";
import { queryKeys } from "../lib/queryKeys.ts";
import { useDeleteItems } from "../lib/useDeleteItems.ts";
import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { DuplicateGroupRow } from "./-duplicates/DuplicateGroupRow.tsx";
import { DuplicateSeasonRows } from "./-duplicates/DuplicateSeasonRows.tsx";
import { VersionPickerDialog } from "./-duplicates/VersionPickerDialog.tsx";
import { SeasonDuplicateDialog } from "./-duplicates/SeasonDuplicateDialog.tsx";
import { QuickCleanupAction } from "../features/quickCleanup/QuickCleanupAction.tsx";
import { versionDeletionExecutionTarget } from "./-duplicates/versionDeletionState.ts";
import { DuplicatesTableSkeleton } from "../components/Skeletons.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { requireAuth } from "../lib/requireAuth.ts";
import { CollectionToolbar, DataSurface, PageHeader } from "../components/Workspace.tsx";
import { ExpandableSearch } from "../components/ExpandableSearch.tsx";
import { InfoTip } from "../features/mediaDeletion/InfoTip.tsx";
import { normalizeSearchQuery } from "@shared/search";
import { useDeletionOperationTracker } from "../features/deletionOperations/DeletionOperationCoordinator.tsx";
import { formatKilobytes } from "../lib/format.ts";
import { duplicatePageSummary } from "./-duplicates/duplicatePresentation.ts";
import type { DuplicateComparisonFilter } from "@shared/mediaComparison";
import "./duplicates.css";
import { useAnySyncStatus } from "../lib/useLibrarySync.tsx";
import { SyncDataNotice } from "../components/SyncDataNotice.tsx";

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
    comparison:
      comparison === "same-profile" || comparison === "different" || comparison === "unknown"
        ? comparison
        : "all",
    search: normalizeSearchQuery(search.search),
  };
}

export const Route = createFileRoute("/duplicates")({
  validateSearch: validateDuplicatesSearch,
  search: {
    middlewares: [stripSearchParams({ type: "all", comparison: "all", search: "" })],
  },
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: DuplicatesPage,
});

function DuplicatesPage() {
  const { type, comparison, search = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { trackDeletionOperation } = useDeletionOperationTracker();
  const { isSyncing } = useAnySyncStatus();

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

  const duplicatesQueryKey = queryKeys.duplicates.list({ type, comparison, search, offset });
  // Keep an already-rendered, settled snapshot from being replaced by intermediate
  // version rows as individual libraries complete. A first visit may still fetch the
  // directory, but review and deletion remain gated for the entire active sync.
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: duplicatesQueryKey,
    queryFn: () =>
      api.duplicates.list({
        type,
        comparison,
        search,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: (prev) => prev,
    enabled: (query) => !isSyncing || query.state.data === undefined,
  });

  const [reviewItem, setReviewItem] = useState<DuplicateGroup | null>(null);
  const [reviewSeason, setReviewSeason] = useState<DuplicateSeasonGroup | null>(null);
  const versionDialogRef = useRef<HTMLDialogElement>(null);
  const seasonDialogRef = useRef<HTMLDialogElement>(null);
  const seasonCleanupRequestId = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!isSyncing) return;
    versionDialogRef.current?.close();
    seasonDialogRef.current?.close();
    setReviewItem(null);
    setReviewSeason(null);
  }, [isSyncing]);

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
      cleanupMediaIds,
      planFingerprint,
      allowRadarrRetainedPathManagement,
      allowRadarrMovieRemoval,
    }: {
      group: DuplicateGroup;
      mediaIds: number[];
      cleanupMediaIds: number[];
      planFingerprint?: string;
      allowRadarrRetainedPathManagement?: boolean;
      allowRadarrMovieRemoval?: boolean;
    }) => {
      if (group.mediaType === "movie") {
        return await api.duplicates.deleteMovieMediaVersions(
          group.ratingKey,
          mediaIds,
          cleanupMediaIds,
          {
            ...(planFingerprint ? { planFingerprint } : {}),
            ...(allowRadarrRetainedPathManagement
              ? { allowRadarrRetainedPathManagement: true }
              : {}),
            ...(allowRadarrMovieRemoval ? { allowRadarrMovieRemoval: true } : {}),
          },
        );
      }
      return await api.duplicates.deleteEpisodeMediaVersions(group.episodeRatingKey, mediaIds);
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

  const deleteSeasonMutation = useMutation({
    mutationFn: (request: {
      selections: Array<{ ratingKey: string; deleteMediaIds: number[] }>;
      analysisFingerprint: string;
      expiresAt: number;
    }) => api.duplicates.seasonCleanup(seasonCleanupRequestId.current, request.selections, request),
    onSuccess: (result) => {
      const invalidations = [
        queryKeys.duplicates.all,
        queryKeys.stale.all,
        queryKeys.libraries.all,
        queryKeys.events.all,
        queryKeys.mediaRemovals.all,
        queryKeys.versionDeletionPreview.all,
      ];
      for (const operationId of result.operationIds) {
        trackDeletionOperation(operationId, invalidations);
      }
      seasonDialogRef.current?.close();
      setReviewSeason(null);
    },
  });

  function handleConfirm(
    group: DuplicateGroup,
    plan: {
      mediaIds: number[];
      deleteWholeItem: boolean;
      deleteFromArr: boolean;
      cleanupDownloads: boolean;
      cleanupMediaIds: number[];
      planFingerprint?: string;
      allowRadarrRetainedPathManagement?: boolean;
      allowRadarrMovieRemoval?: boolean;
    },
  ) {
    if (isSyncing) return;
    if (
      group.mediaType === "movie" &&
      versionDeletionExecutionTarget(group.mediaType, plan.deleteWholeItem) === "whole-item"
    ) {
      deleteWholeItemMutation.mutate(
        {
          libraryKey: group.libraryKey,
          ratingKeys: [group.ratingKey],
          coordinatedRatingKeys: plan.deleteFromArr ? [group.ratingKey] : [],
          cleanupDownloads: plan.deleteFromArr && plan.cleanupDownloads,
          unmonitorRatingKeys: [],
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
      cleanupMediaIds: plan.cleanupMediaIds,
      planFingerprint: plan.planFingerprint,
      allowRadarrRetainedPathManagement: plan.allowRadarrRetainedPathManagement,
      allowRadarrMovieRemoval: plan.allowRadarrMovieRemoval,
    });
  }

  function openReview(item: DuplicateGroup) {
    if (isSyncing) return;
    seasonDialogRef.current?.close();
    setReviewSeason(null);
    setReviewItem(item);
  }

  function openSeasonReview(season: DuplicateSeasonGroup) {
    if (isSyncing) return;
    seasonCleanupRequestId.current = crypto.randomUUID();
    deleteSeasonMutation.reset();
    setReviewSeason(season);
  }

  function closeReview() {
    versionDialogRef.current?.close();
    setReviewItem(null);
  }

  const page = Math.floor(offset / PAGE_SIZE);
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
  const summary = duplicatePageSummary(data?.groups ?? []);

  return (
    <div className="duplicates-page workspace-page workspace-tone-accent space-y-6">
      <div className="workspace-sticky-header sticky top-0 z-20">
        <PageHeader
          eyebrow="Storage intelligence"
          title="Duplicate versions"
          icon={Copy}
          tone="accent"
          description={data
            ? (
              `${data.duplicateGroupTotal.toLocaleString()} movies or episodes with multiple synced versions`
            )
            : <span className="skeleton inline-block h-3 w-40 align-middle" />}
          actions={<QuickCleanupAction disabled={isSyncing} />}
        />
      </div>

      {isSyncing && (
        <SyncDataNotice>
          Counts and version details may be incomplete while Plex syncs. Review and cleanup actions
          are paused until the finished results load automatically.
        </SyncDataNotice>
      )}

      {isError
        ? (
          <ErrorAlert
            message={error instanceof Error ? error.message : "Failed to load duplicates"}
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
                      onChange={(e) => setComparison(e.target.value as DuplicateComparisonFilter)}
                      aria-label="Filter by technical comparison"
                    >
                      <option value="all">All comparisons</option>
                      <option value="same-profile">Same technical profile</option>
                      <option value="different">Meaningful differences</option>
                      <option value="unknown">Needs review</option>
                    </select>
                    <InfoTip text="Compares Plex-reported resolution, codec, HDR, and audio/subtitle tracks across a group's versions. “Same technical profile” means those fields match, not that the files are byte-identical. “Needs review” means Plex didn't report enough fields to compare." />
                  </span>
                </>
              }
              meta={data
                ? search
                  ? `${data.duplicateGroupTotal.toLocaleString()} match${
                    data.duplicateGroupTotal === 1 ? "" : "es"
                  } in ${data.total.toLocaleString()} movie/season rows`
                  : `${data.duplicateGroupTotal.toLocaleString()} duplicate groups · ${data.total.toLocaleString()} movie/season rows`
                : undefined}
            />

            {data && data.groups.length > 0 && (
              <section className="duplicates-summary" aria-label="Duplicate storage summary">
                <div className="duplicates-summary-card duplicates-summary-card-versions">
                  <span className="duplicates-summary-icon">
                    <Layers3 className="size-4" />
                  </span>
                  <span className="duplicates-summary-copy">
                    <span>Versions in this review pass</span>
                    <strong>{summary.versionCount.toLocaleString()}</strong>
                  </span>
                </div>
                <div className="duplicates-summary-card duplicates-summary-card-storage">
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
                <div className="duplicates-summary-card duplicates-summary-card-reclaimable">
                  <span className="duplicates-summary-icon">
                    <Sparkles className="size-4" />
                  </span>
                  <span className="duplicates-summary-copy">
                    <span>Potential savings · largest kept</span>
                    <strong>
                      {summary.reclaimableKilobytes != null
                        ? formatKilobytes(summary.reclaimableKilobytes)
                        : "Unknown"}
                    </strong>
                  </span>
                </div>
              </section>
            )}

            {isLoading ? <DuplicatesTableSkeleton /> : data && data.groups.length === 0
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
                        <th>Duplicates</th>
                        <th>Storage footprint</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data?.groups.map((item) =>
                        item.mediaType === "movie"
                          ? (
                            <DuplicateGroupRow
                              key={item.ratingKey}
                              item={item}
                              onReview={() => openReview(item)}
                              disabled={isSyncing}
                            />
                          )
                          : (
                            <DuplicateSeasonRows
                              key={`${item.showRatingKey}:${item.seasonRatingKey}`}
                              season={item}
                              disabled={isSyncing}
                              onReviewSeason={openSeasonReview}
                              onReviewEpisode={openReview}
                            />
                          )
                      )}
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
        pending={deleteVersionsMutation.isPending || deleteWholeItemMutation.isPending}
        error={deleteVersionsMutation.error ?? deleteWholeItemMutation.error}
        onConfirm={(plan) => reviewItem && handleConfirm(reviewItem, plan)}
        onCancel={closeReview}
      />
      <SeasonDuplicateDialog
        dialogRef={seasonDialogRef}
        season={reviewSeason}
        pending={deleteSeasonMutation.isPending}
        error={deleteSeasonMutation.error}
        onConfirm={(selections) => deleteSeasonMutation.mutate(selections)}
        onClose={() => setReviewSeason(null)}
      />
    </div>
  );
}
