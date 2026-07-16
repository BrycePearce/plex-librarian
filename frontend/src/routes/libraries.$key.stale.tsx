import {
  createFileRoute,
  Link,
  stripSearchParams,
} from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  Clock3,
  Copy,
  Database,
  HardDrive,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { api, isNotFoundError } from "../lib/api";
import type {
  DeleteItemsResponse,
  SortKey,
  StaleItem,
  StaleParams,
} from "../lib/api";
import { formatKilobytes } from "../lib/format";
import { useLibrarySync } from "../lib/useLibrarySync";
import { useNotSyncedYet } from "../lib/useNotSyncedYet";
import { useDeleteItems } from "../lib/useDeleteItems";
import { requireAuth } from "../lib/requireAuth";
import { StaleTableSkeleton } from "../components/Skeletons";
import { NotSyncedYetCard } from "../components/NotSyncedYetCard";
import { ErrorAlert } from "../components/ErrorAlert";
import { HistorySyncWarning } from "../components/HistorySyncWarning";
import { DeleteResultAlert } from "../components/DeleteResultAlert";
import { Pagination } from "../components/Pagination";
import { useItemSelection } from "./-stale/useItemSelection";
import { useScrollToOffset } from "./-stale/useScrollToOffset";
import { StaleFilters } from "./-stale/StaleFilters";
import { ExpandableSearch } from "../components/ExpandableSearch";
import { normalizeSearchQuery } from "@shared/search";
import { StaleItemsTable } from "./-stale/StaleItemsTable";
import { SelectionActionBar } from "./-stale/SelectionActionBar";
import { DeleteConfirmDialog } from "../features/mediaDeletion/DeleteConfirmDialog";
import { CollectionToolbar } from "../components/Workspace";
import "./libraries.$key.stale.css";

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
// stays at the bare `/stale` path instead of accumulating `?days=365&filter=all&...` on every
// load, while any control the user actually changes shows up in the URL (and survives a
// refresh or the browser Back button).
const staleSearchDefaults = {
  days: 365,
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
    days: Number.isInteger(days) && days >= 0 ? days : staleSearchDefaults.days,
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
  beforeLoad: ({ context }) =>
    Promise.all([
      requireAuth(context.queryClient),
      context.queryClient.ensureQueryData({
        queryKey: ["libraries"],
        queryFn: () => api.libraries.list(),
      }),
    ]),
  component: StalePage,
});

function pageFileSize(items: StaleItem[]): number {
  return items.reduce((sum, i) => sum + (i.fileSize ?? 0), 0);
}

function libraryTone(type?: string): "primary" | "secondary" | "accent" {
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
  label: string;
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

function StalePage() {
  const { key } = Route.useParams();
  const qc = useQueryClient();
  const { isSyncing, isSyncStatusLoading, trigger, isError, error } =
    useLibrarySync(key);
  // Reuses the dashboard's shared `['libraries']` cache (no extra request if it's already
  // populated) to get this library's real total item count — `data.total` below is the
  // *filtered* stale count, and `historySyncedAt` resets to null on every sync attempt,
  // not just the first, so neither can distinguish "never synced" from "just resyncing
  // an already-populated library with nothing currently stale."
  const { data: librariesData } = useQuery({
    queryKey: ["libraries"],
    queryFn: () => api.libraries.list(),
  });
  const thisLibrary = librariesData?.libraries.find((l) => l.key === key);
  const thisLibraryItemCount = thisLibrary?.itemCount ?? 0;
  const params = Route.useSearch();
  const navigate = Route.useNavigate();

  // A page/sort/filter/grace-period change replaces the whole visible set with rows that
  // weren't shown before, while deleting an item just removes it from the same set — only
  // the latter should play the row exit fade. Defaults to `false` (plain keyed array, no
  // AnimatePresence wrapper, see `StaleItemsTable`) because that's the common case, letting
  // React swap old rows for new ones in a single synchronous commit with no exit animation
  // lifecycle to race against the incoming rows.
  //
  // Flipped to `true` only right before a same-page deletion (see deleteMutation below), and
  // back to `false` by the *next* navigation rather than immediately once the delete settles
  // — resetting it right away would force an unwanted extra remount of the very rows that
  // just finished settling (every row's file-size bar replays its grow-in animation on
  // mount, so a wrapper toggle with no actual key change is very visible). Since `setParams`
  // is the single choke point for every navigation, resetting there means the flip is a
  // total no-op (bails out, no re-render) on every navigation that doesn't follow a delete.
  const [animateRowRemoval, setAnimateRowRemoval] = useState(false);
  function setParams(updater: (prev: StaleParams) => StaleParams) {
    setAnimateRowRemoval(false);
    void navigate({ search: updater, replace: true });
  }

  const {
    data,
    isLoading,
    isFetching,
    isError: isStaleError,
    error: staleError,
    refetch: refetchStale,
  } = useQuery({
    queryKey: ["stale", key, params],
    queryFn: () => api.libraries.stale(key, { ...params, limit: PAGE_SIZE }),
    placeholderData: (prev) => prev,
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
    if (!data) return;
    const offset = params.offset ?? 0;
    const nextOffset = offset + PAGE_SIZE;
    if (nextOffset < data.total) {
      void qc.prefetchQuery({
        queryKey: ["stale", key, { ...params, offset: nextOffset }],
        queryFn: () =>
          api.libraries.stale(key, { ...params, limit: PAGE_SIZE, offset: nextOffset }),
      });
    }
    const prevOffset = offset - PAGE_SIZE;
    if (prevOffset >= 0) {
      void qc.prefetchQuery({
        queryKey: ["stale", key, { ...params, offset: prevOffset }],
        queryFn: () =>
          api.libraries.stale(key, { ...params, limit: PAGE_SIZE, offset: prevOffset }),
      });
    }
  }, [data, params, key, qc]);

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
      void qc.invalidateQueries({ queryKey: ["libraries"] });
    },
  });

  const pageItems = data?.items ?? [];
  const selection = useItemSelection(pageItems);

  const [deleteResult, setDeleteResult] = useState<DeleteItemsResponse | null>(
    null,
  );
  const [confirmItems, setConfirmItems] = useState<StaleItem[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const deleteMutation = useDeleteItems([
    ["stale", key],
    ["events"],
    ["media-removals"],
  ]);

  const goToOffset = useScrollToOffset(
    params.offset ?? 0,
    (offset) => setParams((p) => ({ ...p, offset })),
  );

  function openConfirm(items: StaleItem[]) {
    setDeleteResult(null);
    setConfirmItems(items);
    dialogRef.current?.showModal();
  }

  function closeConfirm() {
    dialogRef.current?.close();
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
      className={`stale-page workspace-tone-${
        libraryTone(
          thisLibrary?.type,
        )
      } space-y-6 ${selection.selected.size > 0 ? "pb-20" : ""}`}
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
            </div>
            <p className="text-base-content/50 text-sm">
              {data
                ? (
                  <>
                    {data.total.toLocaleString()} items ·{" "}
                    {formatKilobytes(pageFileSize(data.items))} on this page
                  </>
                )
                : isNotSyncedYet
                ? (
                  "Not synced yet"
                )
                : (
                  <span className="skeleton inline-block h-3 w-40 align-middle" />
                )}
            </p>
          </div>
          <div className="library-header-actions flex flex-col items-end gap-1">
            <div className="flex gap-2">
              {(thisLibrary?.type === "movie" ||
                thisLibrary?.type === "show") && (
                <Link
                  to="/duplicates"
                  search={{
                    type: thisLibrary.type === "show" ? "tv" : "movie",
                  }}
                  className="btn btn-ghost btn-sm gap-2"
                  title="Find items with multiple synced versions"
                >
                  <Copy className="w-4 h-4" />
                  Duplicates
                </Link>
              )}
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
            </div>
            {isError && (
              <span className="text-xs text-error">
                {error instanceof Error ? error.message : "Sync failed"}
              </span>
            )}
          </div>
        </div>

        {showFilters && (
          <div className="library-filter-surface">
            <div className="library-filter-title">
              <SlidersHorizontal className="size-4" /> Analysis controls
            </div>
            <StaleFilters
              days={params.days ?? staleSearchDefaults.days}
              filter={params.filter ?? staleSearchDefaults.filter}
              onDaysChange={(days) =>
                setParams((p) => ({ ...p, days, offset: 0 }))}
              onFilterChange={(filter) =>
                setParams((p) => ({ ...p, filter, offset: 0 }))}
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
            value={thisLibrary
              ? formatKilobytes(thisLibrary.totalFileSize)
              : "—"}
          />
          <LibraryInsight
            icon={<Clock3 />}
            label="Inactive for"
            value={(params.days ?? staleSearchDefaults.days) === 0
              ? "Everything"
              : `${params.days ?? staleSearchDefaults.days}+ days`}
          />
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
            {data && (
              <HistorySyncWarning
                historySyncedAt={data.historySyncedAt}
                isSyncing={isSyncing}
                isSyncStatusLoading={isSyncStatusLoading}
                syncingMessage={
                  <>
                    Watch-history sync is running — "unknown" items may update
                    once it finishes.
                  </>
                }
                warningMessage={
                  <>
                    Watch-history sync hasn't completed for this library yet, so
                    items showing{" "}
                    <span className="badge badge-outline badge-sm align-middle">
                      unknown
                    </span>{" "}
                    below may actually have been watched — the "never watched"
                    data isn't reliable until a sync finishes. Avoid deleting
                    based on watch status until this clears.
                  </>
                }
              />
            )}

            {deleteResult && (
              <DeleteResultAlert
                variant={deleteResult.failed.length > 0 ||
                    deleteResult.partial.length > 0
                  ? "warning"
                  : "success"}
                onDismiss={() => setDeleteResult(null)}
              >
                Deleted {deleteResult.deleted.length} item
                {deleteResult.deleted.length === 1 ? "" : "s"}.
                {deleteResult.partial.length > 0 && (
                  <>
                    {" "}
                    {deleteResult.partial.length}{" "}
                    partially completed; files were removed from{" "}
                    {deleteResult.partial
                      .flatMap((item) =>
                        item.deletedInstances.map(
                          (instance) => instance.instanceName,
                        )
                      )
                      .join(", ")}
                    , but failed in {deleteResult.partial
                      .flatMap((item) =>
                        item.failedInstances.map(
                          (instance) =>
                            `${instance.instanceName}: ${instance.error}`,
                        )
                      )
                      .join("; ")}
                    . Retry to reconcile the remaining instances.
                  </>
                )}
                {deleteResult.failed.length > 0 && (
                  <>
                    {" "}
                    {deleteResult.failed.length} failed:{" "}
                    {deleteResult.failed.map((f) => f.error).join("; ")}
                  </>
                )}
              </DeleteResultAlert>
            )}

            <CollectionToolbar
              eyebrow="Content review"
              title="Stale items"
              actions={
                <ExpandableSearch
                  search={params.search ?? staleSearchDefaults.search}
                  pending={isFetching}
                  label="Search stale titles"
                  placeholder="Search all matching titles..."
                  onSearchChange={(search) =>
                    setParams((p) => ({ ...p, search, offset: 0 }))}
                />
              }
              meta={data
                ? params.search
                  ? `${data.total.toLocaleString()} match${
                    data.total === 1 ? "" : "es"
                  }`
                  : `Showing ${pageItems.length.toLocaleString()} of ${data.total.toLocaleString()}`
                : undefined}
            />

            <SelectionActionBar
              count={selection.selected.size}
              totalSize={selection.selectedTotalSize}
              onClear={selection.clear}
              onDelete={() => openConfirm(selection.selectedItems)}
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
                animateRowRemoval={animateRowRemoval}
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
              onSuccess: (res) => {
                selection.remove(res.deleted);
                setDeleteResult(res);
                dialogRef.current?.close();
                setAnimateRowRemoval(true);
              },
            },
          )}
        onCancel={closeConfirm}
      />
    </div>
  );
}
