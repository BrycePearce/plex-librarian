import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import type {
  DeleteItemsResponse,
  StaleParams,
  StaleItem,
  SortKey,
} from "../lib/api";
import { formatKilobytes, formatDate } from "../lib/format";
import { useLibrarySync } from "../lib/useLibrarySync";
import { StaleTableSkeleton } from "../components/Skeletons";

export const Route = createFileRoute("/libraries/$key/stale")({
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

const PAGE_SIZE = 50;

function StalePage() {
  const { key } = Route.useParams();
  const qc = useQueryClient();
  const { isSyncing, trigger, isError, error } = useLibrarySync(key);
  const [params, setParams] = useState<StaleParams>({
    days: 365,
    filter: "all",
    sort: "fileSize",
    order: "desc",
    limit: PAGE_SIZE,
    offset: 0,
  });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["stale", key, params],
    queryFn: () => api.libraries.stale(key, params),
    placeholderData: (prev) => prev,
  });

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
      void qc.invalidateQueries({ queryKey: ["stale", key] });
      void qc.invalidateQueries({ queryKey: ["events"] });
    },
  });

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
  const allOnPageSelected =
    pageItems.length > 0 && pageItems.every((i) => selected.has(i.ratingKey));
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

  const gracePeriodValue =
    params.minAgeDays !== undefined
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

  return (
    <div className={`space-y-6 ${selected.size > 0 ? "pb-20" : ""}`}>
      <div className="flex items-center gap-4">
        <Link to="/dashboard" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Stale Items</h1>
          <p className="text-base-content/50 text-sm">
            {data ? (
              <>
                {data.total.toLocaleString()} items ·{" "}
                {formatKilobytes(pageFileSize(data.items))} on this page
              </>
            ) : (
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

      {data &&
        data.historySyncedAt === null &&
        (isSyncing ? (
          <div className="alert alert-info alert-soft py-2 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span>
              Watch-history sync is running — "unknown" items may update once
              it finishes.
            </span>
          </div>
        ) : (
          <div className="alert alert-warning">
            <AlertTriangle className="w-4 h-4" />
            <span>
              Watch-history sync hasn't completed for this library yet, so
              items showing{" "}
              <span className="badge badge-warning badge-outline badge-sm align-middle">
                unknown
              </span>{" "}
              below may actually have been watched — the "never watched" data
              isn't reliable until a sync finishes. Avoid deleting based on
              watch status until this clears.
            </span>
          </div>
        ))}

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
              }))
            }
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
              }))
            }
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

      {deleteResult && (
        <div
          className={`alert ${deleteResult.failed.length > 0 ? "alert-warning" : "alert-success"}`}
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
              {selected.size} item{selected.size === 1 ? "" : "s"} selected ·{" "}
              {formatKilobytes(selectedTotalSize)}
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

      {isLoading ? (
        <StaleTableSkeleton />
      ) : (
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
                      if (el)
                        el.indeterminate =
                          !allOnPageSelected && someOnPageSelected;
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
            </tbody>
          </table>
          {data?.items.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-20 text-base-content/40">
              <Sparkles className="w-8 h-8" />
              <p className="font-medium text-base-content/60">All caught up</p>
              <p className="text-sm">No stale items match these filters.</p>
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
            onClick={() =>
              setParams((p) => ({ ...p, offset: (page - 1) * PAGE_SIZE }))
            }
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
            onClick={() =>
              setParams((p) => ({ ...p, offset: (page + 1) * PAGE_SIZE }))
            }
          >
            Next
          </button>
        </div>
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
                deleteMutation.mutate(confirmItems.map((i) => i.ratingKey))
              }
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
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
        {active ? (
          params.order === "desc" ? (
            <ArrowDown className="w-3 h-3" />
          ) : (
            <ArrowUp className="w-3 h-3" />
          )
        ) : (
          <span className="w-3 h-3 opacity-0">
            <ArrowDown className="w-3 h-3" />
          </span>
        )}
      </button>
    </th>
  );
}

// `hidden`/`exit` play on delete (always) and, when `animateIn` is set, on first mount too.
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
    ? `/api/proxy/thumb?path=${encodeURIComponent(item.thumb)}&width=60&height=90`
    : null;

  const titleEl = (
    <div className="min-w-0">
      <div className="font-medium truncate max-w-xs">{item.title}</div>
      {item.year && (
        <div className="text-xs text-base-content/40">{item.year}</div>
      )}
    </div>
  );

  const sizePct =
    item.fileSize != null
      ? Math.max(4, (item.fileSize / maxFileSize) * 100)
      : 0;

  return (
    <motion.tr
      variants={rowVariants}
      initial={animateIn ? "hidden" : false}
      animate="visible"
      exit="exit"
      transition={
        animateIn
          ? {
              duration: 0.16,
              ease: "easeOut",
              delay: Math.min(index, 12) * 0.02,
            }
          : undefined
      }
      className="hover group"
    >
      <td>
        <input
          type="checkbox"
          className="checkbox checkbox-sm"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${item.title}`}
        />
      </td>
      <td>
        <div className="flex items-center gap-3">
          <div className="w-10 h-14 rounded overflow-hidden shrink-0 bg-base-300">
            {thumbUrl && (
              <img
                src={thumbUrl}
                alt=""
                className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                loading="lazy"
              />
            )}
          </div>
          {item.type === "show" ? (
            <Link
              to="/libraries/$key/shows/$ratingKey"
              params={{ key: item.libraryKey, ratingKey: item.ratingKey }}
              className="hover:text-primary transition-colors min-w-0"
            >
              {titleEl}
            </Link>
          ) : (
            titleEl
          )}
        </div>
      </td>
      <td className="text-sm font-mono truncate relative overflow-hidden">
        {item.fileSize != null && (
          <div
            className="absolute inset-y-1.5 left-0 bg-primary/15 rounded-sm"
            style={{ width: `${sizePct}%` }}
          />
        )}
        <span className="relative">
          {item.fileSize != null ? formatKilobytes(item.fileSize) : "—"}
        </span>
      </td>
      <td className="text-sm text-base-content/70 truncate">
        {item.lastViewedAt ? (
          formatDate(item.lastViewedAt)
        ) : historyUnknown ? (
          <span
            className="badge badge-warning badge-outline badge-sm"
            title="Watch-history sync hasn't completed for this library — this item may actually have been watched"
          >
            unknown
          </span>
        ) : (
          <span className="badge badge-outline badge-sm">never</span>
        )}
      </td>
      <td className="text-sm text-base-content/70 truncate">
        {item.addedAt ? formatDate(item.addedAt) : "—"}
      </td>
      <td className="text-sm font-mono truncate">{item.viewCount ?? 0}</td>
      <td className="overflow-hidden">
        <motion.button
          type="button"
          className={`btn btn-ghost btn-xs btn-square text-error ${selected ? "" : "pointer-events-none"}`}
          onClick={onDelete}
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
