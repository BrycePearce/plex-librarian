import {
  createFileRoute,
  Link,
  redirect,
  stripSearchParams,
} from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api, isNotFoundError } from "../lib/api";
import type {
  DeleteItemsResponse,
  SortKey,
  StaleItem,
  StaleParams,
} from "../lib/api";
import { formatDate, formatKilobytes } from "../lib/format";
import { useLibrarySync } from "../lib/useLibrarySync";
import { StaleTableSkeleton } from "../components/Skeletons";
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
    days: Number.isFinite(days) && days > 0 ? days : staleSearchDefaults.days,
    filter: (FILTERS as readonly string[]).includes(search.filter as string)
      ? (search.filter as StaleParams["filter"])
      : staleSearchDefaults.filter,
    sort: SORT_KEYS.includes(search.sort as SortKey)
      ? (search.sort as SortKey)
      : staleSearchDefaults.sort,
    order: search.order === "asc" ? "asc" : staleSearchDefaults.order,
    offset: Number.isFinite(offset) && offset >= 0
      ? Math.floor(offset)
      : staleSearchDefaults.offset,
    limit: PAGE_SIZE,
    ...(Number.isFinite(minAgeDays) && minAgeDays >= 0 ? { minAgeDays } : {}),
  };
}

export const Route = createFileRoute("/libraries/$key/stale")({
  validateSearch: validateStaleSearch,
  search: {
    middlewares: [stripSearchParams(staleSearchDefaults)],
  },
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ["auth", "status"],
      queryFn: api.auth.status,
      staleTime: 60_000,
    });
    if (!status.configured) throw redirect({ to: "/setup" });
  },
  component: StalePage,
});

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
  const thisLibraryItemCount =
    librariesData?.libraries.find((l) => l.key === key)?.itemCount ?? 0;
  const params = Route.useSearch();
  const navigate = Route.useNavigate();

  // A page/sort/filter/grace-period change replaces the whole visible set with rows that
  // weren't shown before, while deleting an item just removes it from the same set — only
  // the latter should play the row exit fade. Defaults to `false` (plain keyed array, no
  // AnimatePresence wrapper) because that's the common case — pagination/sort/filter — and
  // it lets React swap old rows for new ones in a single synchronous commit with no exit
  // animation lifecycle to race against the incoming rows. Without that, AnimatePresence
  // kept the outgoing page's rows mounted until their exit animation's completion callback
  // fired (which resolves a tick later, not synchronously) while the incoming page's rows
  // mounted immediately, so both pages briefly coexisted in the tbody before the old ones
  // were removed.
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
    queryFn: () => api.libraries.stale(key, params),
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
          api.libraries.stale(key, { ...params, offset: nextOffset }),
      });
    }
    const prevOffset = offset - PAGE_SIZE;
    if (prevOffset >= 0) {
      void qc.prefetchQuery({
        queryKey: ["stale", key, { ...params, offset: prevOffset }],
        queryFn: () =>
          api.libraries.stale(key, { ...params, offset: prevOffset }),
      });
    }
  }, [data, params, key, qc]);

  // Distinguishes "hasn't synced yet" (legitimate, resolves itself once sync reaches
  // this library) from a real failure, so the page can show the right one instead of
  // crashing on `data?.items.map` with `data` undefined or spinning a skeleton forever.
  // Also requires a sync to plausibly still be running: the backend returns the same 404
  // for "not synced yet" and "library was deleted from Plex" / "no active server", so
  // without this a permanently-gone library would show "will resolve automatically"
  // forever instead of the real error.
  const isNotSyncedYet = isStaleError &&
    isNotFoundError(staleError) &&
    (isSyncing || isSyncStatusLoading);

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

  const [selected, setSelected] = useState<Map<string, StaleItem>>(new Map());
  const [deleteResult, setDeleteResult] = useState<DeleteItemsResponse | null>(
    null,
  );
  const [confirmItems, setConfirmItems] = useState<StaleItem[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const deleteMutation = useMutation({
    mutationFn: (ratingKeys: string[]) =>
      api.libraries.deleteItems(key, ratingKeys),
    onSuccess: (res) => {
      setSelected((prev) => {
        const next = new Map(prev);
        for (const ratingKey of res.deleted) next.delete(ratingKey);
        return next;
      });
      setDeleteResult(res);
      dialogRef.current?.close();
      setAnimateRowRemoval(true);
      void qc.invalidateQueries({ queryKey: ["stale", key] });
      void qc.invalidateQueries({ queryKey: ["events"] });
    },
  });

  // `<main>` (not the window) is the app's sole scroll container (see __root.tsx) — Previous
  // and Next both jump to its top rather than one of them preserving scroll position, since
  // the page below is entirely different content either direction; leaving Previous scrolled
  // to the bottom would land the user mid-list on a page they haven't looked at yet.
  //
  // The scroll only starts once React has actually committed a render reflecting the new
  // offset — tracked via this ref rather than assuming `setParams` (now a router `navigate`)
  // applies synchronously, which it doesn't reliably do: navigation is async internally, so a
  // `flushSync` wrapped around it (the previous approach, back when this was a plain
  // `setState`) would silently do nothing and let the scroll race a mid-flight DOM change. A
  // page swap isn't just a possible height change (a partial last page), it's ~50 rows worth of
  // file-size bars each animating `width` from 0 on mount, which forces a layout recalculation
  // every frame for ~500ms — any of that landing mid-flight can clamp or visibly stutter an
  // in-progress smooth scroll. Keying off the committed `params.offset` instead means the
  // effect can't fire until the DOM has already settled, no matter how the update was
  // scheduled internally.
  //
  // The scroll itself is deferred one more frame (`requestAnimationFrame`) past that commit
  // because a commit only guarantees the DOM update, not that the browser has painted/
  // rasterized it yet — starting the scroll in the same tick could composite into rows that
  // don't have painted tiles ready, which briefly showed as a black flash. Waiting a frame lets
  // that paint happen first.
  const scrollTargetRef = useRef<number | null>(null);
  function goToOffset(offset: number) {
    scrollTargetRef.current = offset;
    setParams((p) => ({ ...p, offset }));
  }
  useEffect(() => {
    if (scrollTargetRef.current !== params.offset) return;
    scrollTargetRef.current = null;
    const reducedMotion = globalThis.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    requestAnimationFrame(() => {
      document
        .querySelector(".scroll-area")
        ?.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
    });
  }, [params.offset]);

  function toggleOne(item: StaleItem) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.ratingKey)) next.delete(item.ratingKey);
      else next.set(item.ratingKey, item);
      return next;
    });
  }

  const pageItems = data?.items ?? [];
  const maxPageFileSize = Math.max(1, ...pageItems.map((i) => i.fileSize ?? 0));
  const allOnPageSelected = pageItems.length > 0 &&
    pageItems.every((i) => selected.has(i.ratingKey));
  const someOnPageSelected = pageItems.some((i) => selected.has(i.ratingKey));

  function toggleAllOnPage() {
    setSelected((prev) => {
      const next = new Map(prev);
      if (allOnPageSelected) {
        for (const item of pageItems) next.delete(item.ratingKey);
      } else {
        for (const item of pageItems) next.set(item.ratingKey, item);
      }
      return next;
    });
  }

  function openConfirm(items: StaleItem[]) {
    setDeleteResult(null);
    setConfirmItems(items);
    dialogRef.current?.showModal();
  }

  function closeConfirm() {
    dialogRef.current?.close();
  }

  const selectedItems = Array.from(selected.values());
  const selectedTotalSize = selectedItems.reduce(
    (sum, i) => sum + (i.fileSize ?? 0),
    0,
  );
  const confirmTotalSize = confirmItems.reduce(
    (sum, i) => sum + (i.fileSize ?? 0),
    0,
  );

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
    <div className={`space-y-6 ${selected.size > 0 ? "pb-20" : ""}`}>
      {
        /* Sticky (not the table) per explicit preference: the back/title/sync row and the
          filter controls pin to the top of <main>'s scroll as you scroll past them, while
          the table scrolls away normally underneath — no bounded/independently-scrolling
          table box. */
      }
      <div className="sticky top-0 z-20 bg-base-100 -mx-4 px-4 pt-2 pb-4 space-y-4 border-b border-base-300">
        <div className="flex items-center gap-4">
          <Link to="/dashboard" className="btn btn-ghost btn-sm gap-1">
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">Stale Items</h1>
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
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              className="btn btn-sm gap-2"
              onClick={trigger}
              disabled={isSyncing}
            >
              <RefreshCw
                className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
              />
              {isSyncing ? "Syncing…" : "Sync"}
            </button>
            {isError && (
              <span className="text-xs text-error">
                {error instanceof Error ? error.message : "Sync failed"}
              </span>
            )}
          </div>
        </div>

        {showFilters && (
          <div className="flex flex-wrap gap-3">
            <label className="form-control gap-1">
              <span className="label-text text-xs">Not viewed in</span>
              <select
                className="select select-bordered select-sm"
                value={params.days}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    days: Number(e.target.value),
                    offset: 0,
                  }))}
              >
                <option value={90}>3 months</option>
                <option value={180}>6 months</option>
                <option value={365}>1 year</option>
                <option value={730}>2 years</option>
                <option value={1095}>3 years</option>
              </select>
            </label>
            <label className="form-control gap-1">
              <span className="label-text text-xs">Filter</span>
              <select
                className="select select-bordered select-sm"
                value={params.filter}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    filter: e.target.value as StaleParams["filter"],
                    offset: 0,
                  }))}
              >
                <option value="all">All</option>
                <option value="watched">Watched</option>
                <option value="unwatched">Unwatched</option>
              </select>
            </label>
            <label className="form-control gap-1">
              <span className="label-text text-xs">New item grace period</span>
              <select
                className="select select-bordered select-sm"
                value={gracePeriodValue}
                onChange={(e) => setGracePeriod(e.target.value)}
              >
                <option value="default">
                  {gracePeriodValue === "default" && data
                    ? `Default (${data.minAgeDays} days)`
                    : "Default"}
                </option>
                <option value={0}>No grace period</option>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
                <option value={365}>1 year</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {isNotSyncedYet
        ? (
          <div className="card bg-base-200 shadow-xl">
            <div className="card-body items-center text-center gap-4 py-14">
              <span className="loading loading-ring w-12 text-primary" />
              <div>
                <h2 className="card-title text-xl justify-center">
                  This library hasn't synced yet
                </h2>
                <p className="text-base-content/60 max-w-md">
                  It's still queued behind other libraries in the current sync —
                  this page will pick it up automatically once it's ready.
                </p>
              </div>
            </div>
          </div>
        )
        : isStaleError
        ? (
          <div className="alert alert-error">
            <AlertCircle className="w-4 h-4" />
            <span>
              {staleError instanceof Error
                ? staleError.message
                : "Failed to load stale items"}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-xs gap-1"
              onClick={() => void refetchStale()}
            >
              <RefreshCw className="w-3 h-3" /> Try again
            </button>
          </div>
        )
        : (
          <>
            {data &&
              data.historySyncedAt === null &&
              (isSyncing
                ? (
                  <div className="alert alert-info alert-soft py-2 text-sm banner-beam banner-beam-info">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>
                      Watch-history sync is running — "unknown" items may update
                      once it finishes.
                    </span>
                  </div>
                )
                : isSyncStatusLoading
                ? null
                : (
                  <div className="alert alert-warning banner-beam banner-beam-warning">
                    <AlertTriangle className="w-4 h-4" />
                    <span>
                      Watch-history sync hasn't completed for this library yet,
                      so items showing{" "}
                      <span className="badge badge-outline badge-sm align-middle">
                        unknown
                      </span>{" "}
                      below may actually have been watched — the "never watched"
                      data isn't reliable until a sync finishes. Avoid deleting
                      based on watch status until this clears.
                    </span>
                  </div>
                ))}

            {deleteResult && (
              <div
                className={`alert ${
                  deleteResult.failed.length > 0
                    ? "alert-warning"
                    : "alert-success"
                }`}
              >
                <span>
                  Deleted {deleteResult.deleted.length} item
                  {deleteResult.deleted.length === 1 ? "" : "s"}.
                  {deleteResult.failed.length > 0 && (
                    <>
                      {" "}
                      {deleteResult.failed.length} failed:{" "}
                      {deleteResult.failed.map((f) => f.error).join("; ")}
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => setDeleteResult(null)}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            <AnimatePresence>
              {selected.size > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 40 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 40 }}
                  transition={{ type: "spring", stiffness: 300, damping: 28 }}
                  className="fixed bottom-6 left-0 right-0 mx-auto w-fit z-20 alert bg-base-200 shadow-xl border border-base-300 flex items-center justify-between gap-6"
                >
                  <span>
                    {selected.size} item{selected.size === 1 ? "" : "s"}{" "}
                    selected · {formatKilobytes(selectedTotalSize)}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setSelected(new Map())}
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-error gap-2"
                      onClick={() => openConfirm(selectedItems)}
                    >
                      <Trash2 className="w-4 h-4" /> Delete selected
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {isLoading
              ? <StaleTableSkeleton />
              : (
                <div className="overflow-x-auto">
                  <progress
                    className={`progress progress-primary w-full h-0.5 mb-1 transition-opacity ${
                      isFetching ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <table className="table table-sm table-fixed overflow-hidden">
                    <colgroup>
                      <col className="w-8" />
                      <col />
                      <col className="w-24" />
                      <col className="w-32" />
                      <col className="w-32" />
                      <col className="w-16" />
                      <col className="w-10" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            className="checkbox checkbox-sm"
                            checked={allOnPageSelected}
                            ref={(el) => {
                              if (el) {
                                el.indeterminate = !allOnPageSelected &&
                                  someOnPageSelected;
                              }
                            }}
                            onChange={toggleAllOnPage}
                            aria-label="Select all on this page"
                          />
                        </th>
                        <SortTh
                          label="Title"
                          field="title"
                          params={params}
                          onSort={setSort}
                        />
                        <SortTh
                          label="Size"
                          field="fileSize"
                          params={params}
                          onSort={setSort}
                        />
                        <SortTh
                          label="Last viewed"
                          field="lastViewedAt"
                          params={params}
                          onSort={setSort}
                        />
                        <SortTh
                          label="Added"
                          field="addedAt"
                          params={params}
                          onSort={setSort}
                        />
                        <SortTh
                          label="Plays"
                          field="viewCount"
                          params={params}
                          onSort={setSort}
                        />
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {animateRowRemoval
                        ? (
                          <AnimatePresence>
                            {data?.items.map((item, index) => (
                              <ItemRow
                                key={item.ratingKey}
                                item={item}
                                index={index}
                                animateIn={!hasAnimatedIn}
                                maxFileSize={maxPageFileSize}
                                selected={selected.has(item.ratingKey)}
                                onToggle={() => toggleOne(item)}
                                onDelete={() => openConfirm([item])}
                                historyUnknown={data.historySyncedAt === null}
                              />
                            ))}
                          </AnimatePresence>
                        )
                        : (
                          // Plain keyed array, deliberately NOT wrapped in AnimatePresence: even
                          // with a zero-duration exit variant, AnimatePresence keeps an outgoing
                          // element mounted until its exit animation's completion callback fires
                          // (which resolves a tick later, not synchronously), while incoming
                          // elements mount immediately — so old and new rows still briefly coexist
                          // in the tbody. A plain array lets React swap keys in one synchronous
                          // commit with no exit lifecycle to wait on, which is what a page/sort/
                          // filter navigation needs. See `animateRowRemoval` above for why this is
                          // the default branch, only swapped out right before a deletion.
                          data?.items.map((item, index) => (
                            <ItemRow
                              key={item.ratingKey}
                              item={item}
                              index={index}
                              animateIn={!hasAnimatedIn}
                              maxFileSize={maxPageFileSize}
                              selected={selected.has(item.ratingKey)}
                              onToggle={() => toggleOne(item)}
                              onDelete={() => openConfirm([item])}
                              historyUnknown={data.historySyncedAt === null}
                            />
                          ))
                        )}
                    </tbody>
                  </table>
                  {data?.items.length === 0 && (
                    <div className="flex flex-col items-center gap-2 py-20 text-base-content/40">
                      {isSyncing && thisLibraryItemCount === 0
                        ? (
                          <>
                            <span className="loading loading-spinner loading-md" />
                            <p className="font-medium text-base-content/60">
                              Still importing this library
                            </p>
                            <p className="text-sm">
                              Items will show up here once the sync finishes.
                            </p>
                          </>
                        )
                        : (
                          <>
                            <Sparkles className="w-8 h-8" />
                            <p className="font-medium text-base-content/60">
                              All caught up
                            </p>
                            <p className="text-sm">
                              No stale items match these filters.
                            </p>
                          </>
                        )}
                    </div>
                  )}
                </div>
              )}

            {totalPages > 1 && (
              <div className="flex justify-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={page === 0}
                  onClick={() => goToOffset((page - 1) * PAGE_SIZE)}
                >
                  Previous
                </button>
                <span className="btn btn-sm btn-ghost no-animation pointer-events-none">
                  {page + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => goToOffset((page + 1) * PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}

      <dialog ref={dialogRef} className="modal" onClose={closeConfirm}>
        <div className="modal-box">
          <h3 className="font-bold text-lg flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-error" /> Delete{" "}
            {confirmItems.length} item
            {confirmItems.length === 1 ? "" : "s"}?
          </h3>
          <p className="py-2 text-sm text-base-content/70">
            This permanently deletes the underlying media file
            {confirmItems.length === 1 ? "" : "s"} from your Plex server (
            <span className="font-semibold text-base-content">
              {formatKilobytes(confirmTotalSize)}
            </span>{" "}
            total). This cannot be undone.
          </p>
          <ul className="mt-3 max-h-56 overflow-y-auto text-sm py-1 divide-y divide-base-300/50 rounded-lg border border-base-300 bg-base-200/40">
            {confirmItems.map((item) => (
              <li
                key={item.ratingKey}
                className="flex items-center justify-between gap-3 px-3 py-1.5"
              >
                <span className="truncate min-w-0 flex-1">{item.title}</span>
                <span className="text-base-content/50 font-mono text-xs shrink-0">
                  {item.fileSize != null ? formatKilobytes(item.fileSize) : "—"}
                </span>
              </li>
            ))}
          </ul>
          {deleteMutation.isError && (
            <p className="text-error text-sm">
              {deleteMutation.error instanceof Error
                ? deleteMutation.error.message
                : "Delete failed"}
            </p>
          )}
          <div className="modal-action mt-3">
            <button
              type="button"
              className="btn btn-sm"
              onClick={closeConfirm}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-error gap-2"
              onClick={() =>
                deleteMutation.mutate(confirmItems.map((i) => i.ratingKey))}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending
                ? <span className="loading loading-spinner loading-xs" />
                : <Trash2 className="w-4 h-4" />}
              Delete permanently
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="submit" disabled={deleteMutation.isPending}>
            close
          </button>
        </form>
      </dialog>
    </div>
  );
}

function SortTh({
  label,
  field,
  params,
  onSort,
}: {
  label: string;
  field: SortKey;
  params: StaleParams;
  onSort: (f: SortKey) => void;
}) {
  const active = params.sort === field;
  return (
    <th>
      <button
        type="button"
        className="flex items-center gap-1 hover:text-primary transition-colors"
        onClick={() => onSort(field)}
      >
        {label}
        {active
          ? (
            params.order === "desc"
              ? <ArrowDown className="w-3 h-3" />
              : <ArrowUp className="w-3 h-3" />
          )
          : (
            <span className="w-3 h-3 opacity-0">
              <ArrowDown className="w-3 h-3" />
            </span>
          )}
      </button>
    </th>
  );
}

// `hidden`/`exit` play on delete (rows are only ever wrapped in AnimatePresence for a
// same-page deletion — see `animateRowRemoval` above) and, when `animateIn` is set, on first
// mount too.
// Opacity-only, deliberately no `y` offset: a translateY here once caused the table's
// `overflow-x-auto` wrapper to briefly grow its own vertical scrollbar mid-animation (it
// implicitly computes `overflow-y: auto` from having `overflow-x: auto` set at all), which
// snapped the table's width back once the animation settled. Not worth reintroducing for a
// barely-perceptible slide effect.
// The entrance transition (with its index-driven stagger delay) is passed as a plain prop
// rather than baked into the variants, since motion's dynamic (function) variants don't
// play well with a nested `transition` field under this version's types — the `exit`
// variant's own `transition` still overrides it for the delete animation.
const rowVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: {
    opacity: 0,
    transition: { duration: 0.15, ease: "easeIn" as const },
  },
};

// A relative "how overdue" scale for the whole displayed set, not an absolute judgment —
// every row here already failed the "not viewed in" filter, so this is about which of the
// already-stale rows are the most stale, the same way the size bar is relative to the
// page's own max rather than some fixed byte threshold.
const DAY_SEC = 86_400;
function staleDotInfo(
  lastViewedAt: number,
): { className: string; title: string } {
  const daysSince = (Date.now() / 1000 - lastViewedAt) / DAY_SEC;
  if (daysSince > 730) {
    return { className: "bg-error", title: "Not viewed in over 2 years" };
  }
  if (daysSince > 365) {
    return { className: "bg-warning", title: "Not viewed in over 1 year" };
  }
  return { className: "bg-success", title: "Viewed within the last year" };
}

function ItemRow({
  item,
  index,
  animateIn,
  maxFileSize,
  selected,
  onToggle,
  onDelete,
  historyUnknown,
}: {
  item: StaleItem;
  index: number;
  animateIn: boolean;
  maxFileSize: number;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
  historyUnknown: boolean;
}) {
  const thumbUrl = item.thumb
    ? `/api/proxy/thumb?path=${
      encodeURIComponent(item.thumb)
    }&width=60&height=90`
    : null;

  const titleEl = (
    <div className="min-w-0">
      <div className="font-medium truncate max-w-xs">{item.title}</div>
      {item.year && (
        <div className="text-xs text-base-content/40">{item.year}</div>
      )}
    </div>
  );

  const sizePct = item.fileSize != null
    ? Math.max(4, (item.fileSize / maxFileSize) * 100)
    : 0;

  const dotInfo = item.lastViewedAt ? staleDotInfo(item.lastViewedAt) : null;

  return (
    <motion.tr
      variants={rowVariants}
      initial={animateIn ? "hidden" : false}
      animate="visible"
      exit="exit"
      transition={animateIn
        ? {
          duration: 0.16,
          ease: "easeOut",
          delay: Math.min(index, 12) * 0.02,
        }
        : undefined}
      className={`row-hover group cursor-pointer ${
        selected ? "row-selected" : ""
      }`}
      onClick={onToggle}
    >
      <td
        className={`row-accent ${
          selected ? "shadow-[inset_3px_0_0_0_var(--color-primary)]" : ""
        }`}
      >
        <input
          type="checkbox"
          className="checkbox checkbox-sm"
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${item.title}`}
        />
      </td>
      <td className="row-accent">
        {item.type === "show"
          ? (
            <Link
              to="/libraries/$key/shows/$ratingKey"
              params={{ key: item.libraryKey, ratingKey: item.ratingKey }}
              onClick={(e) => e.stopPropagation()}
              className="group/poster inline-flex items-center gap-3 hover:text-primary transition-colors max-w-full"
            >
              <div className="w-10 h-14 rounded overflow-hidden shrink-0 bg-base-300 transition-shadow duration-200 group-hover/poster:shadow-lg group-hover/poster:ring-2 group-hover/poster:ring-primary/40">
                {thumbUrl && (
                  <img
                    src={thumbUrl}
                    alt=""
                    className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                    loading="lazy"
                  />
                )}
              </div>
              {titleEl}
            </Link>
          )
          : (
            <div className="flex items-center gap-3">
              <div className="w-10 h-14 rounded overflow-hidden shrink-0 bg-base-300 transition-shadow duration-200 group-hover:shadow-lg group-hover:ring-2 group-hover:ring-primary/40">
                {thumbUrl && (
                  <img
                    src={thumbUrl}
                    alt=""
                    className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                    loading="lazy"
                  />
                )}
              </div>
              {titleEl}
            </div>
          )}
      </td>
      <td className="row-accent text-sm font-mono truncate relative overflow-hidden">
        {item.fileSize != null && (
          <motion.div
            className="absolute inset-y-1.5 left-0 bg-primary/15 rounded-sm"
            initial={{ width: 0 }}
            animate={{ width: `${sizePct}%` }}
            transition={{
              duration: 0.5,
              ease: "easeOut",
              delay: animateIn ? Math.min(index, 12) * 0.02 : 0,
            }}
          />
        )}
        <span className="relative">
          {item.fileSize != null ? formatKilobytes(item.fileSize) : "—"}
        </span>
      </td>
      <td className="row-accent text-sm text-base-content/70 truncate">
        {item.lastViewedAt && dotInfo
          ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotInfo.className}`}
                title={dotInfo.title}
              />
              {formatDate(item.lastViewedAt)}
            </span>
          )
          : historyUnknown
          ? (
            <span
              className="badge badge-warning badge-outline badge-sm"
              title="Watch-history sync hasn't completed for this library — this item may actually have been watched"
            >
              unknown
            </span>
          )
          : (
            <span className="badge badge-error badge-outline badge-sm">
              never
            </span>
          )}
      </td>
      <td className="row-accent text-sm text-base-content/70 truncate">
        {item.addedAt ? formatDate(item.addedAt) : "—"}
      </td>
      <td className="row-accent text-sm font-mono truncate">
        {item.viewCount ?? 0}
      </td>
      <td className="row-accent overflow-hidden">
        <motion.button
          type="button"
          className={`btn btn-ghost btn-xs btn-square text-error ${
            selected ? "" : "pointer-events-none"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete ${item.title}`}
          title="Delete this item"
          tabIndex={selected ? 0 : -1}
          initial={false}
          animate={{ opacity: selected ? 1 : 0, x: selected ? 0 : -36 }}
          transition={{
            type: "spring",
            stiffness: 180,
            damping: 16,
            mass: 0.6,
          }}
        >
          <Trash2 className="w-4 h-4" />
        </motion.button>
      </td>
    </motion.tr>
  );
}

function pageFileSize(items: StaleItem[]): number {
  return items.reduce((sum, i) => sum + (i.fileSize ?? 0), 0);
}
