import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { BadgeCheck, Copy, HardDrive, Layers3, Sparkles } from "lucide-react";

import { api } from "../lib/api.ts";
import type { DuplicateGroup, DuplicateSeasonGroup } from "../lib/api.ts";
import { queryKeys } from "../lib/queryKeys.ts";

import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { DuplicateGroupRow } from "./-duplicates/DuplicateGroupRow.tsx";
import { DuplicateSeasonRows } from "./-duplicates/DuplicateSeasonRows.tsx";
import { ServiceVersionPickerDialog } from "../features/mediaDeletion/ServiceVersionPickerDialog.tsx";
import "../components/dataSurfaces.css";

import { QuickCleanupAction } from "../features/quickCleanup/QuickCleanupAction.tsx";

import { DuplicatesTableSkeleton } from "../components/Skeletons.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { requireAuth } from "../lib/requireAuth.ts";
import {
  CollectionToolbar,
  DataSurface,
  PageHeader,
  workspaceToneClass,
} from "../components/Workspace.tsx";
import { ExpandableSearch } from "../components/ExpandableSearch.tsx";
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
  const [reviewPending, setReviewPending] = useState(false);

  useEffect(() => {
    if (!isSyncing || reviewPending) return;
    versionDialogRef.current?.close();
    seasonDialogRef.current?.close();
    setReviewItem(null);
    setReviewSeason(null);
  }, [isSyncing, reviewPending]);

  function deletionCreated(operationId: string) {
    trackDeletionOperation(operationId, [
      queryKeys.duplicates.all,
      queryKeys.stale.all,
      queryKeys.libraries.all,
      queryKeys.events.all,
      queryKeys.mediaRemovals.all,
      queryKeys.versionDeletionPreview.all,
    ]);
    versionDialogRef.current?.close();
    seasonDialogRef.current?.close();
    setReviewItem(null);
    setReviewSeason(null);
  }
  function openReview(item: DuplicateGroup) {
    if (isSyncing) return;
    seasonDialogRef.current?.close();
    setReviewSeason(null);
    setReviewItem(item);
  }

  function openSeasonReview(season: DuplicateSeasonGroup) {
    if (isSyncing) return;

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
    <div className={`duplicates-page workspace-page ${workspaceToneClass("accent")} space-y-6`}>
      <div className="workspace-sticky-header sticky top-0 z-20">
        <PageHeader
          eyebrow="Storage intelligence"
          title="Duplicate versions"
          icon={Copy}
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
                  <select
                    className="select select-bordered select-sm w-44 max-w-full"
                    value={comparison}
                    onChange={(e) =>
                      setComparison(e.target.value as DuplicateComparisonFilter)}
                    aria-label="Filter by technical comparison"
                  >
                    <option value="all">All comparisons</option>
                    <option value="same-profile">Same technical profile</option>
                    <option value="different">Meaningful differences</option>
                    <option value="unknown">Needs review</option>
                  </select>
                </>
              }
              meta={data && (search || type !== "all" || comparison !== "all")
                ? `${data.total.toLocaleString()} result${data.total === 1 ? "" : "s"}`
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

      {reviewItem && (
        <ServiceVersionPickerDialog
          key={reviewItem.mediaType === "movie"
            ? reviewItem.ratingKey
            : reviewItem.episodeRatingKey}
          dialogRef={versionDialogRef}
          groups={[reviewItem]}
          onCreated={deletionCreated}
          onPendingChange={setReviewPending}
          onCancel={closeReview}
        />
      )}
      {reviewSeason && (
        <ServiceVersionPickerDialog
          key={reviewSeason.seasonRatingKey}
          dialogRef={seasonDialogRef}
          groups={reviewSeason.episodes}
          onCreated={deletionCreated}
          onPendingChange={setReviewPending}
          onCancel={() => {
            seasonDialogRef.current?.close();
            setReviewSeason(null);
          }}
        />
      )}
    </div>
  );
}
