import {
  createFileRoute,
  redirect,
  useNavigate,
  Link,
} from "@tanstack/react-router";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import {
  RefreshCw,
  Film,
  Tv,
  Music,
  AlertCircle,
  CheckCircle,
  LogOut,
  ChevronDown,
  Settings,
  Info,
} from "lucide-react";
import { api } from "../lib/api";
import type { SyncLog, AuthStatus, Library, LibrarySyncProgress, LibraryPhase } from "../lib/api";
import { formatRelativeTime, formatDuration } from "../lib/format";
import { useLibrarySync, LibrarySyncProvider, useAnyLibrarySyncing } from "../lib/useLibrarySync";
import { useSyncStream } from "../lib/useSyncStream";

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

function DashboardInner() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [activeGlobalSyncId, setActiveGlobalSyncId] = useState<number | null>(
    null,
  );

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["auth", "status"],
    queryFn: api.auth.status,
    staleTime: 60_000,
  });

  const disconnect = useMutation({
    mutationFn: api.auth.disconnect,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["auth", "status"] });
      void navigate({ to: "/setup" });
    },
  });

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

  const isSyncing = activeGlobalSyncId !== null || triggerSync.isPending;
  const anyLibrarySyncing = useAnyLibrarySyncing();

  const { data: history } = useQuery({
    queryKey: ["sync", "history"],
    queryFn: () => api.sync.history(10),
  });

  // `anyLibrarySyncing` only tracks syncs started while this page is mounted — a sync
  // kicked off from a library's stale page is lost from that count once you navigate
  // back here. `history` is always freshly fetched on mount, so fall back to it to
  // catch syncs still pending from elsewhere (avoids a 409 + flicker on "Sync all").
  const anyPendingSync = history?.some((h) => h.status === "pending") ?? false;
  const isAnySyncing = isSyncing || anyLibrarySyncing || anyPendingSync;

  // Re-attach to a pending global sync after a page refresh.
  useEffect(() => {
    if (activeGlobalSyncId !== null) return;
    const pending = history?.find((h) => h.status === 'pending' && h.libraryKey === null);
    if (pending) setActiveGlobalSyncId(pending.id);
  }, [history, activeGlobalSyncId]);

  const { progress: globalSyncProgress, isDone: globalSyncDone, error: globalSyncError } =
    useSyncStream(activeGlobalSyncId);

  useEffect(() => {
    if (activeGlobalSyncId === null) return;
    if (!globalSyncDone && globalSyncError === null) return;
    void qc.invalidateQueries({ queryKey: ["libraries"] });
    void qc.invalidateQueries({ queryKey: ["sync", "history"] });
    setActiveGlobalSyncId(null);
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
          {authStatus?.source !== "env" && (
            <button
              type="button"
              className="btn btn-ghost gap-2"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
              title="Disconnect from Plex"
            >
              <LogOut className="w-4 h-4" />
              Disconnect
            </button>
          )}
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

      {activeGlobalSyncId !== null && (
        <SyncProgressPanel progress={globalSyncProgress ?? undefined} />
      )}
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
        <div className="flex justify-center py-20">
          <span className="loading loading-spinner loading-lg" />
        </div>
      )}
      {libsError && (
        <div className="alert alert-error">
          <AlertCircle className="w-4 h-4" />
          <span>Failed to load libraries</span>
        </div>
      )}
      {librariesData && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {librariesData.libraries.map((lib) => (
            <LibraryCard key={lib.key} lib={lib} globalSyncing={isSyncing} />
          ))}
        </div>
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
                    libraryTitle={
                      s.libraryKey
                        ? (librariesData?.libraries.find(
                            (l) => l.key === s.libraryKey,
                          )?.title ?? s.libraryKey)
                        : null
                    }
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

function useCountUp(target: number, duration = 800) {
  const [display, setDisplay] = useState(target);
  const prevRef = useRef(target);

  useEffect(() => {
    const start = prevRef.current;
    const diff = target - start;
    if (diff <= 0) { setDisplay(target); prevRef.current = target; return; }

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
  }, [target, duration]);

  return display;
}

const PHASE_LABEL: Record<LibraryPhase, string> = {
  pending: 'Waiting',
  items: 'Syncing items',
  episodes: 'Indexing episodes',
  tracks: 'Indexing tracks',
  history: 'Syncing history',
  done: 'Done',
};

function LibraryProgressRow({ lib }: { lib: LibrarySyncProgress }) {
  const count = useCountUp(lib.count);
  const done = lib.phase === 'done';
  const pending = lib.phase === 'pending';
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-4 shrink-0 flex items-center justify-center">
        {done
          ? <CheckCircle className="w-4 h-4 text-success" />
          : pending
          ? null
          : <span className="loading loading-spinner loading-xs" />}
      </div>
      <span className={`w-36 truncate font-medium ${pending ? 'text-base-content/30' : ''}`}>
        {lib.title}
      </span>
      <span className="text-base-content/40 w-36">
        {PHASE_LABEL[lib.phase]}
        {lib.phase === 'done' && lib.elapsedSeconds != null && (
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

function SyncProgressPanel({ progress }: { progress?: LibrarySyncProgress[] }) {
  const [expanded, setExpanded] = useState(false);
  const totalItems = progress?.reduce((sum, l) => sum + l.count, 0) ?? 0;
  const animatedTotal = useCountUp(totalItems);

  if (!progress?.length) {
    return (
      <div className="alert">
        <span className="loading loading-spinner loading-sm" />
        <span>Sync starting…</span>
      </div>
    );
  }

  const doneCount = progress.filter((l) => l.phase === 'done').length;
  const isSingle = progress.length === 1;

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-0 py-3">
        <button
          type="button"
          className="flex items-center gap-3 text-sm w-full text-left"
          onClick={() => setExpanded((e) => !e)}
        >
          <span className="loading loading-spinner loading-xs shrink-0" />
          <span className="font-medium flex-1">
            {isSingle
              ? `${progress[0].title} — ${PHASE_LABEL[progress[0].phase]}`
              : `Syncing ${progress.length} libraries`}
          </span>
          {!isSingle && (
            <span className="text-base-content/40 text-xs">
              {doneCount} of {progress.length} done
            </span>
          )}
          <span className="font-mono text-base-content/40 text-xs">
            {animatedTotal.toLocaleString()} items
          </span>
          <ChevronDown
            className={`w-4 h-4 text-base-content/40 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
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

function LibraryCard({ lib, globalSyncing }: { lib: Library; globalSyncing: boolean }) {
  const { isSyncing, trigger } = useLibrarySync(lib.key);
  const navigate = useNavigate();
  return (
    <div
      className="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer"
      onClick={() => void navigate({ to: "/libraries/$key/stale", params: { key: lib.key } })}
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
            className="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/40 hover:text-base-content"
            onClick={(e) => { e.stopPropagation(); trigger(); }}
            disabled={isSyncing || globalSyncing}
            title="Sync this library"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="text-xs text-base-content/40">
          Synced {formatRelativeTime(lib.syncedAt)}
        </div>
      </div>
    </div>
  );
}

function LibraryIcon({ type }: { type: string }) {
  const cls = "w-8 h-8 p-1.5 rounded-lg shrink-0";
  if (type === "movie")
    return <Film className={`${cls} bg-primary/20 text-primary`} />;
  if (type === "show")
    return <Tv className={`${cls} bg-secondary/20 text-secondary`} />;
  if (type === "artist")
    return <Music className={`${cls} bg-accent/20 text-accent`} />;
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
