import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Variants } from "motion/react";
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  Clock,
  Database,
  Film,
  HardDrive,
  Info,
  Music,
  RefreshCw,
  Settings,
  Tv,
} from "lucide-react";
import { api } from "../lib/api";
import type {
  Library,
  LibraryPhase,
  LibrarySyncProgress,
  SyncLog,
} from "../lib/api";
import {
  formatDuration,
  formatKilobytes,
  formatRelativeTime,
} from "../lib/format";
import {
  LibrarySyncProvider,
  useAnyLibrarySyncing,
  useLibrarySync,
  useSyncHistory,
} from "../lib/useLibrarySync";
import { useSyncStream } from "../lib/useSyncStream";
import {
  LibraryCardSkeleton,
  StatsStripSkeleton,
} from "../components/Skeletons";

// Shared orchestration for the stats strip and library grid: the container just declares
// the stagger timing, each child only needs `variants={cardVariants}` to inherit the
// hidden → show transition from whichever container it's mounted under.
const containerVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 300, damping: 26 },
  },
};

export const Route = createFileRoute("/dashboard")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ["auth", "status"],
      queryFn: api.auth.status,
      staleTime: 60_000,
    });
    if (!status.configured) throw redirect({ to: "/setup" });
  },
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <LibrarySyncProvider>
      <DashboardInner />
    </LibrarySyncProvider>
  );
}

// Matches the skeleton's hardcoded card count below — capping the real grid to the
// same number means a library list longer than this can never cause a skeleton→real
// layout shift once data loads (see LibraryCardSkeleton usage further down).
const LIBRARY_PREVIEW_COUNT = 6;

function DashboardInner() {
  const qc = useQueryClient();
  const [activeGlobalSyncId, setActiveGlobalSyncId] = useState<number | null>(
    null,
  );
  const [showAllLibraries, setShowAllLibraries] = useState(false);

  const {
    data: librariesData,
    isLoading: libsLoading,
    error: libsError,
  } = useQuery({
    queryKey: ["libraries"],
    queryFn: () => api.libraries.list(),
  });

  const triggerSync = useMutation({
    mutationFn: () => api.sync.trigger(),
    onSuccess: (data) => {
      setActiveGlobalSyncId(data.syncId);
      void qc.invalidateQueries({ queryKey: ["sync", "history"] });
    },
  });

  const anyLibrarySyncing = useAnyLibrarySyncing();

  const { data: history } = useSyncHistory();

  // Re-attach to a pending global sync after a page refresh.
  useEffect(() => {
    if (activeGlobalSyncId !== null) return;
    const pending = history?.find((h) =>
      h.status === "pending" && h.libraryKey === null
    );
    if (pending) setActiveGlobalSyncId(pending.id);
  }, [history, activeGlobalSyncId]);

  const {
    progress: globalSyncProgress,
    isDone: globalSyncDone,
    error: globalSyncError,
  } = useSyncStream(activeGlobalSyncId);

  // Re-enables "Sync all" the moment the sync finishes, even though the progress panel
  // below stays mounted a bit longer to show a completed state (see the effect below).
  const isSyncing = (activeGlobalSyncId !== null && !globalSyncDone) ||
    triggerSync.isPending;

  // `anyLibrarySyncing` only tracks syncs started while this page is mounted — a sync
  // kicked off from a library's stale page is lost from that count once you navigate
  // back here. `history` is always freshly fetched on mount, so fall back to it to
  // catch syncs still pending from elsewhere (avoids a 409 + flicker on "Sync all").
  const anyPendingSync = history?.some((h) => h.status === "pending") ?? false;
  const isAnySyncing = isSyncing || anyLibrarySyncing || anyPendingSync;

  useEffect(() => {
    if (activeGlobalSyncId === null) return;
    if (!globalSyncDone && globalSyncError === null) return;
    void qc.invalidateQueries({ queryKey: ["libraries"] });
    void qc.invalidateQueries({ queryKey: ["sync", "history"] });
    if (globalSyncError !== null) {
      setActiveGlobalSyncId(null);
      return;
    }
    // Success: keep the panel mounted a bit longer showing a "synced" state instead of
    // clearing it immediately — otherwise a fast sync on a small library flashes the
    // panel for a fraction of a second and vanishes before it's readable.
    const timer = setTimeout(() => setActiveGlobalSyncId(null), 2500);
    return () => clearTimeout(timer);
  }, [globalSyncDone, globalSyncError, activeGlobalSyncId, qc]);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Libraries</h1>
          <p className="text-base-content/50 text-sm mt-1">
            {librariesData ? `${librariesData.total} libraries` : "—"}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/settings" className="btn btn-ghost gap-2" title="Settings">
            <Settings className="w-4 h-4" />
            Settings
          </Link>
          <button
            type="button"
            className="btn btn-primary gap-2"
            onClick={() => triggerSync.mutate()}
            disabled={isAnySyncing}
          >
            <RefreshCw
              className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
            />
            {isSyncing ? "Syncing…" : "Sync all"}
          </button>
        </div>
      </div>

      {libsLoading && <StatsStripSkeleton />}
      {librariesData && librariesData.libraries.length > 0 && (
        <StatsStrip libraries={librariesData.libraries} />
      )}

      <AnimatePresence>
        {(activeGlobalSyncId !== null || triggerSync.isPending) && (
          <motion.div
            key="sync-progress"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
          >
            <SyncProgressPanel
              progress={globalSyncProgress ?? undefined}
              done={globalSyncDone}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {globalSyncError !== null && (
        <div className="alert alert-error">
          <AlertCircle className="w-4 h-4" />
          <span>Sync failed: {globalSyncError}</span>
        </div>
      )}
      {triggerSync.isError && (
        <div className="alert alert-warning">
          <AlertCircle className="w-4 h-4" />
          <span>{triggerSync.error.message}</span>
        </div>
      )}

      {libsLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: LIBRARY_PREVIEW_COUNT }).map((_, i) => (
            <LibraryCardSkeleton key={i} />
          ))}
        </div>
      )}
      {libsError && (
        <div className="alert alert-error">
          <AlertCircle className="w-4 h-4" />
          <span>Failed to load libraries</span>
        </div>
      )}
      {librariesData && (
        <>
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="show"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            {(showAllLibraries
              ? librariesData.libraries
              : librariesData.libraries.slice(0, LIBRARY_PREVIEW_COUNT)).map((
                lib,
              ) => (
                <LibraryCard
                  key={lib.key}
                  lib={lib}
                  globalSyncing={isSyncing}
                />
              ))}
          </motion.div>
          {librariesData.libraries.length > LIBRARY_PREVIEW_COUNT && (
            <div className="flex justify-center">
              <button
                type="button"
                className="btn btn-ghost btn-sm gap-1"
                onClick={() => setShowAllLibraries((v) => !v)}
              >
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${
                    showAllLibraries ? "rotate-180" : ""
                  }`}
                />
                {showAllLibraries
                  ? "Show fewer"
                  : `Show ${
                    librariesData.libraries.length - LIBRARY_PREVIEW_COUNT
                  } more`}
              </button>
            </div>
          )}
        </>
      )}

      {history && history.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Recent syncs</h2>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Library</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Items</th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => (
                  <SyncRow
                    key={s.id}
                    sync={s}
                    libraryTitle={s.libraryKey
                      ? (librariesData?.libraries.find(
                        (l) => l.key === s.libraryKey,
                      )?.title ?? s.libraryKey)
                      : null}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// `skipAnimation` snaps straight to `target` instead of easing towards it — used once a
// library/sync has already reached its "done" state, so the displayed count doesn't keep
// visibly climbing after the checkmark/"done" label has already appeared.
function useCountUp(target: number, duration = 800, skipAnimation = false) {
  const [display, setDisplay] = useState(target);
  const prevRef = useRef(target);

  useEffect(() => {
    if (skipAnimation) {
      setDisplay(target);
      prevRef.current = target;
      return;
    }

    const start = prevRef.current;
    const diff = target - start;
    if (diff <= 0) {
      setDisplay(target);
      prevRef.current = target;
      return;
    }

    const startTime = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(start + diff * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else prevRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, skipAnimation]);

  return display;
}

function StatsStrip({ libraries }: { libraries: Library[] }) {
  const totals = libraries.reduce(
    (acc, lib) => {
      acc.items += lib.itemCount;
      acc.size += lib.totalFileSize;
      acc.lastSync = Math.max(acc.lastSync, lib.syncedAt);
      return acc;
    },
    { items: 0, size: 0, lastSync: 0 },
  );

  const animatedItems = useCountUp(totals.items, 900);
  const animatedSize = useCountUp(totals.size, 900);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <StatTile
        icon={<Database className="w-5 h-5" />}
        iconClass="bg-primary/20 text-primary"
        label="Total items"
        value={animatedItems.toLocaleString()}
      />
      <StatTile
        icon={<HardDrive className="w-5 h-5" />}
        iconClass="bg-secondary/20 text-secondary"
        label="Library size"
        value={formatKilobytes(animatedSize)}
      />
      <StatTile
        icon={<Clock className="w-5 h-5" />}
        iconClass="bg-accent/20 text-accent"
        label="Last synced"
        value={totals.lastSync ? formatRelativeTime(totals.lastSync) : "—"}
      />
    </div>
  );
}

function StatTile({
  icon,
  iconClass,
  label,
  value,
}: {
  icon: ReactNode;
  iconClass: string;
  label: string;
  value: string;
}) {
  return (
    <div className="card bg-base-200">
      <div className="card-body flex-row items-center gap-4 py-4">
        <div
          className={`w-10 h-10 rounded-lg shrink-0 flex items-center justify-center ${iconClass}`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs text-base-content/40">{label}</p>
          <p className="text-xl font-semibold font-mono truncate">{value}</p>
        </div>
      </div>
    </div>
  );
}

const PHASE_LABEL: Record<LibraryPhase, string> = {
  pending: "Waiting",
  items: "Syncing items",
  episodes: "Indexing episodes",
  tracks: "Indexing tracks",
  history: "Syncing history",
  done: "Done",
};

function LibraryProgressRow({ lib }: { lib: LibrarySyncProgress }) {
  const done = lib.phase === "done";
  const count = useCountUp(lib.count, 800, done);
  const pending = lib.phase === "pending";
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-4 shrink-0 flex items-center justify-center">
        {done
          ? <CheckCircle className="w-4 h-4 text-success" />
          : pending
          ? null
          : <span className="loading loading-spinner loading-xs" />}
      </div>
      <span
        className={`w-36 truncate font-medium ${
          pending ? "text-base-content/30" : ""
        }`}
      >
        {lib.title}
      </span>
      <span className="text-base-content/40 w-36">
        {PHASE_LABEL[lib.phase]}
        {lib.phase === "done" && lib.elapsedSeconds != null && (
          <span className="ml-1">· {formatDuration(lib.elapsedSeconds)}</span>
        )}
      </span>
      {!pending && (
        <span className="font-mono text-base-content/40 ml-auto">
          {count.toLocaleString()}
        </span>
      )}
    </div>
  );
}

function SyncProgressPanel(
  { progress, done }: { progress?: LibrarySyncProgress[]; done?: boolean },
) {
  const [expanded, setExpanded] = useState(false);
  const totalItems = progress?.reduce((sum, l) => sum + l.count, 0) ?? 0;
  const animatedTotal = useCountUp(totalItems, 800, done);

  if (!progress?.length) {
    return (
      <div className="alert">
        <span className="loading loading-spinner loading-sm" />
        <span>Sync starting…</span>
      </div>
    );
  }

  const doneCount = progress.filter((l) => l.phase === "done").length;
  const isSingle = progress.length === 1;

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-0 py-3">
        <button
          type="button"
          className="flex items-center gap-3 text-sm w-full text-left"
          onClick={() => setExpanded((e) => !e)}
        >
          {done
            ? <CheckCircle className="w-4 h-4 text-success shrink-0" />
            : <span className="loading loading-spinner loading-xs shrink-0" />}
          <span className="font-medium flex-1">
            {done
              ? isSingle
                ? `${progress[0].title} synced`
                : `Synced ${progress.length} libraries`
              : isSingle
              ? `${progress[0].title} — ${PHASE_LABEL[progress[0].phase]}`
              : `Syncing ${progress.length} libraries`}
          </span>
          {!isSingle && !done && (
            <span className="text-base-content/40 text-xs">
              {doneCount} of {progress.length} done
            </span>
          )}
          <span className="font-mono text-base-content/40 text-xs">
            {animatedTotal.toLocaleString()} items
          </span>
          <ChevronDown
            className={`w-4 h-4 text-base-content/40 transition-transform duration-200 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </button>

        {expanded && (
          <div className="flex flex-col gap-2 mt-3 pt-3 border-t border-base-300">
            {progress.map((lib) => (
              <LibraryProgressRow key={lib.key} lib={lib} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LibraryCard(
  { lib, globalSyncing }: { lib: Library; globalSyncing: boolean },
) {
  const { isSyncing, trigger } = useLibrarySync(lib.key);
  const navigate = useNavigate();
  return (
    <motion.div
      variants={cardVariants}
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className="card bg-base-200 hover:bg-base-300 hover:shadow-lg transition-[background-color,box-shadow] cursor-pointer"
      onClick={() =>
        void navigate({
          to: "/libraries/$key/stale",
          params: { key: lib.key },
        })}
    >
      <div className="card-body gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <LibraryIcon type={lib.type} />
            <div className="min-w-0">
              <h2 className="font-semibold truncate">{lib.title}</h2>
              <p className="text-xs text-base-content/40 capitalize">
                {lib.type}
              </p>
            </div>
          </div>
          <button
            type="button"
            className={`btn btn-ghost btn-xs btn-square shrink-0 ${
              isSyncing
                ? "text-primary"
                : "text-base-content/40 hover:text-base-content"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              trigger();
            }}
            disabled={isSyncing || globalSyncing}
            title="Sync this library"
          >
            <RefreshCw
              className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
            />
          </button>
        </div>
        <div className="text-xs text-base-content/40 flex items-center gap-1.5">
          <span>{lib.itemCount.toLocaleString()} items</span>
          <span>·</span>
          <span>{formatKilobytes(lib.totalFileSize)}</span>
          <span>·</span>
          <span>Synced {formatRelativeTime(lib.syncedAt)}</span>
        </div>
      </div>
    </motion.div>
  );
}

function LibraryIcon({ type }: { type: string }) {
  const cls = "w-8 h-8 p-1.5 rounded-lg shrink-0";
  if (type === "movie") {
    return <Film className={`${cls} bg-primary/20 text-primary`} />;
  }
  if (type === "show") {
    return <Tv className={`${cls} bg-secondary/20 text-secondary`} />;
  }
  if (type === "artist") {
    return <Music className={`${cls} bg-accent/20 text-accent`} />;
  }
  return <Film className={`${cls} bg-base-300 text-base-content/40`} />;
}

function SyncRow({
  sync,
  libraryTitle,
}: {
  sync: SyncLog;
  libraryTitle: string | null;
}) {
  return (
    <tr>
      <td>
        {sync.status === "pending" && (
          <span className="badge badge-info gap-1 min-w-22 justify-center leading-none">
            <span className="loading loading-spinner loading-xs" /> pending
          </span>
        )}
        {sync.status === "success" && (
          <span className="badge badge-success gap-1 min-w-22 justify-center leading-none">
            <CheckCircle className="w-3 h-3" /> success
          </span>
        )}
        {sync.status === "error" && (
          <span className="inline-flex items-center gap-1.5">
            <span className="badge badge-error gap-1 min-w-22 justify-center leading-none">
              <AlertCircle className="w-3 h-3" /> error
            </span>
            <span title={sync.error ?? ""}>
              <Info className="w-4 h-4 text-error cursor-help" />
            </span>
          </span>
        )}
      </td>
      <td className="text-sm text-base-content/70">
        {libraryTitle ?? (
          <span className="text-base-content/40">All libraries</span>
        )}
      </td>
      <td className="text-sm text-base-content/70">
        {new Date(sync.startedAt * 1000).toLocaleString()}
      </td>
      <td className="text-sm text-base-content/70">
        {sync.finishedAt
          ? formatDuration(sync.finishedAt - sync.startedAt)
          : "—"}
      </td>
      <td className="text-sm font-mono">
        {(sync.itemsProcessed ?? 0).toLocaleString()}
      </td>
    </tr>
  );
}
