import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, Database, Gauge, HardDrive, RefreshCw, SlidersHorizontal } from "lucide-react";
import { api, ApiError, isNotFoundError } from "../lib/api.ts";
import type { SortKey, StaleItem, StaleParams } from "../lib/api.ts";
import { formatKilobytes } from "../lib/format.ts";
import { queryKeys } from "../lib/queryKeys.ts";
import { useLibrarySync } from "../lib/useLibrarySync.tsx";
import { useNotSyncedYet } from "../lib/useNotSyncedYet.ts";
import { useDeleteItems } from "../lib/useDeleteItems.ts";
import { requireAuth } from "../lib/requireAuth.ts";
import { StaleTableSkeleton } from "../components/Skeletons.tsx";
import { NotSyncedYetCard } from "../components/NotSyncedYetCard.tsx";
import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { HistorySyncWarning } from "../components/HistorySyncWarning.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { useItemSelection } from "./-stale/useItemSelection.ts";
import { useScrollToOffset } from "./-stale/useScrollToOffset.ts";
import {
  lastStalePageOffset,
  requireStaleTotal,
  reuseStaleTotal,
  staleScopesMatch,
} from "./-stale/stalePagination.ts";
import { StaleFilters } from "./-stale/StaleFilters.tsx";
import { ExpandableSearch } from "../components/ExpandableSearch.tsx";
import { normalizeSearchQuery } from "@shared/search";
import { StaleItemsTable } from "./-stale/StaleItemsTable.tsx";
import { SelectionActionBar } from "./-stale/SelectionActionBar.tsx";
import { type SeasonRemovalChoice, SeasonRemovalDialog } from "./-stale/SeasonRemovalDialog.tsx";
import { LibraryQuickCleanupAction } from "./-stale/LibraryQuickCleanupAction.tsx";
import { DeleteConfirmDialog } from "../features/mediaDeletion/DeleteConfirmDialog.tsx";
import { InfoTip } from "../features/mediaDeletion/InfoTip.tsx";
import {
  CollectionToolbar,
  type WorkspaceTone,
  workspaceToneClass,
} from "../components/Workspace.tsx";
import "./libraries.$key.stale.css";
import { useDeletionOperationTracker } from "../features/deletionOperations/DeletionOperationCoordinator.tsx";

const PAGE_SIZE = 50;

const SORT_KEYS: SortKey[] = [
  "fileSize",
  "lastViewedAt",
  "addedAt",
  "title",
  "year",
  "viewCount",
];
const FILTERS = ["all", "watched", "unwatched"] as const;

// Applied both as the useState-style initializer for a fresh visit and as the set of keys
// `stripSearchParams` omits from the URL when the current value matches — so a default view
// stays at the bare `/stale` path instead of accumulating default filters on every load,
// while any control the user actually changes shows up in the URL (and survives a refresh
// or the browser Back button). `days` is intentionally absent: a bare URL means Automatic.
const staleSearchDefaults = {
  scope: "show",
  filter: "all",
  search: "",
  duplicatesOnly: false,
  sort: "fileSize",
  order: "desc",
  offset: 0,
} satisfies Partial<StaleParams>;

// Hand-rolled rather than a zod/valibot schema (no such dependency exists in this frontend) —
// malformed or garbage search params (bad `?sort=`, negative `?offset=`) fall back to defaults
// instead of throwing. `limit` is deliberately never read from the URL: pagination math
// elsewhere (`page`/`totalPages`) assumes it's always exactly `PAGE_SIZE`.
function validateStaleSearch(search: Record<string, unknown>): StaleParams {
  const days = Number(search.days);
  const offset = Number(search.offset);
  const minAgeDays = Number(search.minAgeDays);
  return {
    scope: search.scope === "season" ? "season" : staleSearchDefaults.scope,
    ...(Number.isInteger(days) && days >= 0 ? { days } : {}),
    filter: (FILTERS as readonly string[]).includes(search.filter as string)
      ? (search.filter as StaleParams["filter"])
      : staleSearchDefaults.filter,
    sort: SORT_KEYS.includes(search.sort as SortKey)
      ? (search.sort as SortKey)
      : staleSearchDefaults.sort,
    order: search.order === "asc" ? "asc" : staleSearchDefaults.order,
    // Accepts both a real boolean (set programmatically via navigate({ search })) and
    // the string "true" (a manually-typed or bookmarked URL) — TanStack Router's search
    // serialization doesn't guarantee which shape survives a round trip.
    duplicatesOnly: search.duplicatesOnly === true ||
      search.duplicatesOnly === "true",
    search: normalizeSearchQuery(search.search),
    offset: Number.isFinite(offset) && offset >= 0
      ? Math.floor(offset)
      : staleSearchDefaults.offset,
    ...(Number.isInteger(minAgeDays) && minAgeDays >= 0 ? { minAgeDays } : {}),
  };
}

export const Route = createFileRoute("/libraries/$key/stale")({
  validateSearch: validateStaleSearch,
  search: {
    middlewares: [stripSearchParams(staleSearchDefaults)],
  },
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: StalePage,
});

function pageFileSize(items: StaleItem[]): number {
  return items.reduce((sum, i) => sum + (i.fileSize ?? 0), 0);
}

function libraryTone(type?: string): WorkspaceTone {
  if (type === "show") return "secondary";
  if (type === "artist") return "accent";
  return "primary";
}

function LibraryInsight({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: ReactNode;
  value: string;
}) {
  return (
    <div className="library-insight">
      <span className="library-insight-icon">{icon}</span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
    </div>
  );
}

function formatLibraryMatch(matching: number, total: number): string {
  if (total <= 0) return "—";
  const percentage = Math.min(100, matching / total * 100);
  return percentage >= 10 ? `${Math.round(percentage)}%` : `${percentage.toFixed(1)}%`;
}

function StalePage() {
  const { key } = Route.useParams();
  const qc = useQueryClient();
  const { isSyncing, isSyncStatusLoading, trigger, isError, error } = useLibrarySync(key);
  // Reuses the dashboard's shared `['libraries']` cache (no extra request if it's already
  // populated) to get this library's real total item count — `data.total` below is the
  // *filtered* stale count, and `historySyncedAt` resets to null on every sync attempt,
  // not just the first, so neither can distinguish "never synced" from "just resyncing
  // an already-populated library with nothing currently stale."
  const { data: librariesData } = useQuery({
    queryKey: queryKeys.libraries.all,
    queryFn: () => api.libraries.list(),
  });
  const thisLibrary = librariesData?.libraries.find((l) => l.key === key);
  const thisLibraryItemCount = thisLibrary?.itemCount ?? 0;
  const params = Route.useSearch();
  const seasonScope = thisLibrary?.type === "show" && params.scope === "season";
  const supportsQuickCleanup = thisLibrary?.type === "movie" ||
    (thisLibrary?.type === "show" && !seasonScope);
  const navigate = Route.useNavigate();

  function setParams(updater: (prev: StaleParams) => StaleParams) {
    void navigate({ search: updater, replace: true });
  }

  const {
    data,
    isLoading,
    isFetching,
    isPlaceholderData,
    isError: isStaleError,
    error: staleError,
    refetch: refetchStale,
  } = useQuery({
    queryKey: queryKeys.stale.list(key, params),
    // Visible pages are authoritative: direct deep links and invalidation refetches get
    // a fresh exact total. Speculative adjacent requests below are the only uncounted ones.
    queryFn: async () =>
      requireStaleTotal(
        await api.libraries.stale(key, { ...params, limit: PAGE_SIZE, count: true }),
      ),
    // Show and season rows share a transport shape but have different destructive
    // semantics. Never paint rows from the other scope while the new request settles.
    placeholderData: (prev) =>
      prev && staleScopesMatch(prev.scope, params.scope) ? prev : undefined,
    // A 404 here means this library hasn't been synced even once yet (still queued
    // behind others in the current sync) — retrying won't make the row appear any
    // faster, and `useLibrarySync` below already invalidates this query once the
    // library's own sync completes, so there's nothing to gain by hammering it.
    retry: (failureCount, err) => !isNotFoundError(err) && failureCount < 2,
  });

  // Warms the cache for the adjacent pages as soon as the current one settles, so that by
  // the time someone actually clicks Previous/Next the data is already there — `goToOffset`
  // then swaps rows synchronously instead of racing a live fetch against the smooth-scroll
  // animation, which is what caused the row swap to visibly stutter mid-scroll.
  useEffect(() => {
    // `placeholderData` belongs to the previous query key. A background fetch can also
    // be replacing an expired total. Wait for the authoritative visible request before
    // copying its count into another cache entry.
    if (!data || isPlaceholderData || isFetching) return;
    const offset = params.offset ?? 0;
    const nextOffset = offset + PAGE_SIZE;
    if (nextOffset < data.total) {
      void qc.prefetchQuery({
        queryKey: queryKeys.stale.list(key, {
          ...params,
          offset: nextOffset,
        }),
        queryFn: async () =>
          reuseStaleTotal(
            await api.libraries.stale(key, {
              ...params,
              limit: PAGE_SIZE,
              offset: nextOffset,
              count: false,
            }),
            data.total,
          ),
      });
    }
    const prevOffset = offset - PAGE_SIZE;
    if (prevOffset >= 0) {
      void qc.prefetchQuery({
        queryKey: queryKeys.stale.list(key, {
          ...params,
          offset: prevOffset,
        }),
        queryFn: async () =>
          reuseStaleTotal(
            await api.libraries.stale(key, {
              ...params,
              limit: PAGE_SIZE,
              offset: prevOffset,
              count: false,
            }),
            data.total,
          ),
      });
    }
  }, [data, isFetching, isPlaceholderData, params, key, qc]);

  // Distinguishes "hasn't synced yet" (legitimate, resolves itself once sync reaches
  // this library) from a real failure — also requires a sync to plausibly still be
  // running: the backend returns the same 404 for "not synced yet" and "library was
  // deleted from Plex" / "no active server", so without that a permanently-gone library
  // would show "will resolve automatically" forever instead of the real error.
  const isNotSyncedYet = useNotSyncedYet(
    isStaleError,
    staleError,
    isSyncing || isSyncStatusLoading,
  );

  // Rows stagger in on the very first successful load only — re-enabling this on every
  // sort/filter/page change (rather than a plain `initial={false}`) would restagger the
  // whole table on each interaction, which reads as sluggish rather than polished.
  const [hasAnimatedIn, setHasAnimatedIn] = useState(false);
  useEffect(() => {
    if (isLoading || !data || hasAnimatedIn) return;
    const timer = setTimeout(() => setHasAnimatedIn(true), 600);
    return () => clearTimeout(timer);
  }, [isLoading, data, hasAnimatedIn]);

  const updateGracePeriod = useMutation({
    mutationFn: (staleMinAgeDays: number | null) =>
      api.libraries.updateStaleMinAgeDays(key, staleMinAgeDays),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.libraries.all });
    },
  });

  const pageItems = data?.items ?? [];
  // Selection belongs to the exact visible result page. TanStack Router keeps this route
  // mounted for search-param navigation, so key it explicitly instead of carrying hidden
  // selections across pagination, filtering, searching, or sorting.
  const selectionScope = JSON.stringify([
    key,
    params.scope,
    params.days ?? data?.days ?? "",
    params.minAgeDays ?? "",
    params.filter,
    params.duplicatesOnly ? "duplicates" : "all",
    params.search,
    params.sort,
    params.order,
    params.offset,
  ]);
  const selection = useItemSelection(pageItems, selectionScope);

  const [confirmItems, setConfirmItems] = useState<StaleItem[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const seasonDialogRef = useRef<HTMLDialogElement>(null);
  const [confirmSeason, setConfirmSeason] = useState<StaleItem | null>(null);
  const { trackDeletionOperation } = useDeletionOperationTracker();

  const deleteMutation = useDeleteItems([
    queryKeys.stale.library(key),
    queryKeys.events.all,
    queryKeys.mediaRemovals.all,
  ]);
  const seasonDeleteMutation = useMutation({
    mutationFn: ({ item, choice }: { item: StaleItem; choice: SeasonRemovalChoice }) =>
      api.libraries.deleteSeason(key, item.ratingKey, choice),
    onError: (error, { item, choice }) => {
      if (
        !(error instanceof ApiError) || !error.preview ||
        !("coordinatedConfigured" in error.preview)
      ) return;
      qc.setQueryData(
        [
          "stale-season-removal-preview",
          key,
          item.ratingKey,
          choice.coordinated,
          choice.cleanupDownloads,
        ],
        error.preview,
      );
    },
    onSuccess: (created) => {
      trackDeletionOperation(created.operationId, [
        queryKeys.stale.library(key),
        queryKeys.events.all,
        queryKeys.mediaRemovals.all,
        queryKeys.libraries.all,
      ]);
      selection.clear();
      seasonDialogRef.current?.close();
      setConfirmSeason(null);
    },
  });

  const goToOffset = useScrollToOffset(
    params.offset ?? 0,
    (offset) => setParams((p) => ({ ...p, offset })),
  );

  // A bookmarked offset can become invalid after a sync or durable deletion. Correct it
  // only from a settled counted response; placeholder/background rows may carry an old total.
  useEffect(() => {
    if (!data || isPlaceholderData || isFetching) return;
    const offset = params.offset ?? 0;
    if (offset === 0 || offset < data.total) return;
    const correctedOffset = lastStalePageOffset(data.total, PAGE_SIZE);
    void navigate({
      search: (previous) => ({ ...previous, offset: correctedOffset }),
      replace: true,
    });
  }, [data, isFetching, isPlaceholderData, navigate, params.offset]);

  function openConfirm(items: StaleItem[]) {
    if (seasonScope) {
      if (items.length !== 1) return;
      setConfirmSeason(items[0]!);
      seasonDeleteMutation.reset();
      seasonDialogRef.current?.showModal();
      return;
    }
    setConfirmItems(items);
    dialogRef.current?.showModal();
  }

  function closeConfirm() {
    dialogRef.current?.close();
    seasonDialogRef.current?.close();
    setConfirmSeason(null);
  }

  function setGracePeriod(value: string) {
    const staleMinAgeDays = value === "default" ? null : Number(value);
    setParams((p) => ({
      ...p,
      minAgeDays: staleMinAgeDays ?? undefined,
      offset: 0,
    }));
    updateGracePeriod.mutate(staleMinAgeDays);
  }

  const gracePeriodValue = params.minAgeDays !== undefined
    ? String(params.minAgeDays)
    : data?.libraryStaleMinAgeDays != null
    ? String(data.libraryStaleMinAgeDays)
    : "default";

  const page = Math.floor((params.offset ?? 0) / PAGE_SIZE);
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  function setSort(sort: SortKey) {
    setParams((p) => ({
      ...p,
      sort,
      order: p.sort === sort && p.order === "desc" ? "asc" : "desc",
      offset: 0,
    }));
  }

  const showFilters = !isNotSyncedYet && !isStaleError;

  return (
    <div
      className={`stale-page ${workspaceToneClass(libraryTone(thisLibrary?.type))} space-y-6 ${
        selection.selected.size > 0 ? "pb-20" : ""
      }`}
    >
      {
        /* Sticky (not the table) per explicit preference: the back/title/sync row and the
          filter controls pin to the top of <main>'s scroll as you scroll past them, while
          the table scrolls away normally underneath — no bounded/independently-scrolling
          table box. */
      }
      <div className="library-workspace-header sticky top-0 z-20 -mx-4 px-4 pt-2 pb-4 space-y-4">
        <div className="library-header-row flex items-center gap-4">
          <Link
            to="/dashboard"
            className="library-back-button btn btn-ghost btn-sm"
            aria-label="Back to Home"
            title="Back to Home"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="library-heading flex-1">
            <div className="library-title-line">
              <h1>{thisLibrary?.title ?? "Stale Items"}</h1>
              <span>Stale analysis</span>
              {thisLibrary?.type === "show" && (
                <div
                  className="library-scope-switch"
                  role="tablist"
                  aria-label="Browse stale TV content by"
                >
                  <button
                    type="button"
                    role="tab"
                    className={!seasonScope ? "is-active" : ""}
                    aria-selected={!seasonScope}
                    onClick={() =>
                      setParams((p) => ({
                        ...p,
                        scope: "show",
                        duplicatesOnly: false,
                        offset: 0,
                      }))}
                  >
                    Shows
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className={seasonScope ? "is-active" : ""}
                    aria-selected={seasonScope}
                    onClick={() =>
                      setParams((p) => ({
                        ...p,
                        scope: "season",
                        duplicatesOnly: false,
                        offset: 0,
                      }))}
                  >
                    Seasons
                  </button>
                </div>
              )}
            </div>
            <p className="text-base-content/50 text-sm">
              {data
                ? (
                  <>
                    {data.total.toLocaleString()} {seasonScope ? "seasons" : "items"} ·{" "}
                    {formatKilobytes(pageFileSize(data.items))} on this page
                  </>
                )
                : isNotSyncedYet
                ? (
                  "Not synced yet"
                )
                : <span className="skeleton inline-block h-3 w-40 align-middle" />}
            </p>
          </div>
          <div className="library-header-actions flex flex-col items-end gap-1">
            <div className="flex gap-2">
              {supportsQuickCleanup
                ? (
                  <LibraryQuickCleanupAction
                    libraryKey={key}
                    libraryItemCount={thisLibraryItemCount}
                    automaticThresholdDays={thisLibrary?.automaticQuickCleanupDays ?? 1_095}
                    isSyncing={isSyncing}
                    isSyncStatusLoading={isSyncStatusLoading}
                  />
                )
                : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm gap-2 library-sync-action"
                    onClick={trigger}
                    disabled={isSyncing}
                  >
                    <RefreshCw
                      className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
                    />
                    {isSyncing ? "Syncing…" : "Sync"}
                  </button>
                )}
            </div>
            {isError && (
              <span className="text-xs text-error">
                {error instanceof Error ? error.message : "Sync failed"}
              </span>
            )}
          </div>
        </div>

        {!isNotSyncedYet && !isStaleError && data && (
          <HistorySyncWarning
            historySyncedAt={data.historySyncedAt}
            isSyncing={isSyncing}
            isSyncStatusLoading={isSyncStatusLoading}
            isDataRefreshing={isFetching || isPlaceholderData}
            syncingMessage={
              <>
                Watch-history sync is running — "unknown" items may update once it finishes.
              </>
            }
            warningMessage={
              <>
                Watch-history sync hasn't completed for this library yet, so items showing{" "}
                <span className="badge badge-outline badge-sm align-middle">
                  unknown
                </span>{" "}
                below may actually have been watched — the "never watched" data isn't reliable until
                a sync finishes. Avoid deleting based on watch status until this clears.
              </>
            }
          />
        )}

        {showFilters && (
          <div className="library-filter-surface">
            <div className="library-filter-title">
              <SlidersHorizontal className="size-4" /> Analysis controls
            </div>
            <StaleFilters
              days={data?.days ?? 365}
              automaticDays={data?.automaticStaleDays ?? 365}
              automatic={params.days === undefined}
              filter={params.filter ?? staleSearchDefaults.filter}
              onDaysChange={(days) => setParams((p) => ({ ...p, days, offset: 0 }))}
              onFilterChange={(filter) => setParams((p) => ({ ...p, filter, offset: 0 }))}
              gracePeriodValue={gracePeriodValue}
              defaultGraceDays={data?.minAgeDays}
              onGracePeriodChange={setGracePeriod}
              libraryType={thisLibrary?.type ?? ""}
              duplicatesOnly={params.duplicatesOnly ??
                staleSearchDefaults.duplicatesOnly}
              onDuplicatesOnlyChange={(duplicatesOnly) =>
                setParams((p) => ({ ...p, duplicatesOnly, offset: 0 }))}
            />
          </div>
        )}
      </div>

      {data && !isNotSyncedYet && !isStaleError && (
        <div className="library-insight-strip">
          <LibraryInsight
            icon={<Database />}
            label="Matching items"
            value={data.total.toLocaleString()}
          />
          <LibraryInsight
            icon={<HardDrive />}
            label="On this page"
            value={formatKilobytes(pageFileSize(data.items))}
          />
          <LibraryInsight
            icon={<Database />}
            label="Library size"
            value={thisLibrary ? formatKilobytes(thisLibrary.totalFileSize) : "—"}
          />
          {!seasonScope && (
            <LibraryInsight
              icon={<Gauge />}
              label={
                <span className="library-insight-label">
                  Library match
                  <InfoTip text="Percentage of all titles in this library that match the current filters." />
                </span>
              }
              value={formatLibraryMatch(data.total, thisLibraryItemCount)}
            />
          )}
        </div>
      )}

      {isNotSyncedYet
        ? (
          <NotSyncedYetCard
            title="This library hasn't synced yet"
            message="It's still queued behind other libraries in the current sync — this page will pick it up automatically once it's ready."
          />
        )
        : isStaleError
        ? (
          <ErrorAlert
            message={staleError instanceof Error
              ? staleError.message
              : "Failed to load stale items"}
            onRetry={() => void refetchStale()}
          />
        )
        : (
          <>
            <CollectionToolbar
              eyebrow="Content review"
              title={seasonScope ? "Stale seasons" : "Stale items"}
              actions={
                <ExpandableSearch
                  search={params.search ?? staleSearchDefaults.search}
                  pending={isFetching}
                  label={seasonScope ? "Search stale shows and seasons" : "Search stale titles"}
                  placeholder={seasonScope
                    ? "Search matching shows or seasons..."
                    : "Search all matching titles..."}
                  onSearchChange={(search) => setParams((p) => ({ ...p, search, offset: 0 }))}
                />
              }
              meta={data
                ? params.search
                  ? `${data.total.toLocaleString()} match${data.total === 1 ? "" : "es"}`
                  : `Showing ${pageItems.length.toLocaleString()} of ${data.total.toLocaleString()}`
                : undefined}
            />

            <SelectionActionBar
              count={selection.selected.size}
              totalSize={selection.selectedTotalSize}
              onClear={selection.clear}
              onDelete={() => openConfirm(selection.selectedItems)}
              deleteDisabled={seasonScope && selection.selected.size !== 1}
              deleteTitle={seasonScope && selection.selected.size !== 1
                ? "Whole-season removal currently accepts one season at a time"
                : undefined}
              noun={seasonScope ? "season" : "item"}
            />

            {isLoading ? <StaleTableSkeleton /> : (
              <StaleItemsTable
                items={pageItems}
                params={params}
                onSort={setSort}
                isFetching={isFetching}
                selected={selection.selected}
                onToggle={selection.toggleOne}
                onToggleAll={selection.toggleAllOnPage}
                onDeleteOne={(item) => openConfirm([item])}
                hasAnimatedIn={hasAnimatedIn}
                historySyncedAt={data?.historySyncedAt ?? null}
                isSyncing={isSyncing}
                thisLibraryItemCount={thisLibraryItemCount}
              />
            )}

            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={(p) => goToOffset(p * PAGE_SIZE)}
            />
          </>
        )}

      <DeleteConfirmDialog
        dialogRef={dialogRef}
        libraryKey={key}
        items={confirmItems}
        pending={deleteMutation.isPending}
        error={deleteMutation.error}
        onConfirm={({ coordinatedRatingKeys, cleanupDownloads }) =>
          deleteMutation.mutate(
            {
              libraryKey: key,
              ratingKeys: confirmItems.map((i) => i.ratingKey),
              coordinatedRatingKeys,
              cleanupDownloads,
            },
            {
              onSuccess: () => {
                selection.clear();
                dialogRef.current?.close();
              },
            },
          )}
        onCancel={closeConfirm}
      />
      <SeasonRemovalDialog
        dialogRef={seasonDialogRef}
        libraryKey={key}
        item={confirmSeason}
        pending={seasonDeleteMutation.isPending}
        error={seasonDeleteMutation.error}
        onConfirm={(choice) =>
          confirmSeason && seasonDeleteMutation.mutate({ item: confirmSeason, choice })}
        onCancel={closeConfirm}
      />
    </div>
  );
}
