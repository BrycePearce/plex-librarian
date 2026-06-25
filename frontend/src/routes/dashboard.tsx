import {
  createFileRoute,
  redirect,
  Link,
  useNavigate,
} from "@tanstack/react-router";
import {
  useQuery,
  useMutation,
  useQueryClient,
  skipToken,
} from "@tanstack/react-query";
import { useState, useEffect } from "react";
import {
  RefreshCw,
  Film,
  Tv,
  Music,
  AlertCircle,
  CheckCircle,
  LogOut,
} from "lucide-react";
import { api } from "../lib/api";
import type { SyncLog, AuthStatus, Library } from "../lib/api";
import { formatRelativeTime, formatDuration } from "../lib/format";

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
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [activeGlobalSyncId, setActiveGlobalSyncId] = useState<number | null>(
    null,
  );
  const [activeLibrarySyncIds, setActiveLibrarySyncIds] = useState<
    Map<string, number>
  >(new Map());

  const activePairs: [string, number][] = [...activeLibrarySyncIds.entries()];

  const hasActiveSyncs =
    activeGlobalSyncId !== null || activeLibrarySyncIds.size > 0;

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

  const { data: history } = useQuery({
    queryKey: ["sync", "history"],
    queryFn: () => api.sync.history(10),
    refetchInterval: hasActiveSyncs ? 3_000 : false,
  });

  // Poll the global sync individually for real-time item count in the progress banner.
  const { data: activeSync } = useQuery({
    queryKey: ["sync", activeGlobalSyncId],
    queryFn:
      activeGlobalSyncId !== null
        ? () => api.sync.poll(activeGlobalSyncId)
        : skipToken,
    refetchInterval: (q) =>
      q.state.data?.status === "pending" ? 2_000 : false,
  });

  // Poll each active per-library sync individually so completion is detected regardless
  // of how many entries the history window holds.
  const { data: librarySyncPolls } = useQuery({
    queryKey: ["sync", "library-polls", activePairs.map(([, id]) => id)],
    queryFn: activePairs.length > 0
      ? () => Promise.all(activePairs.map(([, id]) => api.sync.poll(id)))
      : skipToken,
    refetchInterval: activePairs.length > 0 ? 2_000 : false,
  });

  // Detect global sync completion.
  useEffect(() => {
    if (activeGlobalSyncId === null) return;
    if (activeSync?.status === "success") {
      void (async () => {
        await qc.invalidateQueries({ queryKey: ["libraries"] });
        await qc.invalidateQueries({ queryKey: ["sync", "history"] });
        setActiveGlobalSyncId(null);
      })();
    } else if (activeSync?.status === "error") {
      void qc.invalidateQueries({ queryKey: ["sync", "history"] });
      setActiveGlobalSyncId(null);
    }
  }, [activeSync, activeGlobalSyncId, qc]);

  // Detect per-library sync completions via individual polls.
  useEffect(() => {
    if (!librarySyncPolls || activePairs.length === 0) return;
    const completed = new Set<string>();
    activePairs.forEach(([key], i) => {
      const poll = librarySyncPolls[i];
      if (poll?.status === "success" || poll?.status === "error")
        completed.add(key);
    });
    if (completed.size === 0) return;
    void qc.invalidateQueries({ queryKey: ["libraries"] });
    for (const key of completed)
      void qc.invalidateQueries({ queryKey: ["stale", key] });
    setActiveLibrarySyncIds((prev) => {
      const next = new Map(prev);
      for (const key of completed) next.delete(key);
      return next;
    });
  }, [librarySyncPolls, activePairs, qc]);

  const triggerSync = useMutation({
    mutationFn: () => api.sync.trigger(),
    onSuccess: (data) => setActiveGlobalSyncId(data.syncId),
  });

  const triggerLibrarySync = useMutation({
    mutationFn: (key: string) => api.sync.triggerLibrary(key),
    onSuccess: (data, key) =>
      setActiveLibrarySyncIds((prev) => new Map(prev).set(key, data.syncId)),
  });

  const isSyncing = activeGlobalSyncId !== null || triggerSync.isPending;

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
          {authStatus?.source !== "env" && (
            <button
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
            className="btn btn-primary gap-2"
            onClick={() => triggerSync.mutate()}
            disabled={hasActiveSyncs}
          >
            <RefreshCw
              className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
            />
            {isSyncing ? "Syncing…" : "Sync all"}
          </button>
        </div>
      </div>

      {activeSync?.status === "pending" && (
        <div className="alert">
          <span className="loading loading-spinner loading-sm" />
          <span>
            Sync in progress —{" "}
            {(activeSync.itemsProcessed ?? 0).toLocaleString()} items processed
          </span>
        </div>
      )}
      {activeSync?.status === "error" && (
        <div className="alert alert-error">
          <AlertCircle className="w-4 h-4" />
          <span>Sync failed: {activeSync.error}</span>
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
          {librariesData.libraries.map((lib) => {
            const syncing = activeLibrarySyncIds.has(lib.key);
            return (
              <LibraryCard
                key={lib.key}
                lib={lib}
                syncing={syncing}
                disabled={isSyncing || syncing}
                onSync={() => triggerLibrarySync.mutate(lib.key)}
              />
            );
          })}
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

function LibraryCard({
  lib,
  syncing,
  disabled,
  onSync,
}: {
  lib: Library;
  syncing: boolean;
  disabled: boolean;
  onSync: () => void;
}) {
  return (
    <div className="card bg-base-200 hover:bg-base-300 transition-colors">
      <div className="card-body gap-3">
        <div className="flex items-center gap-3">
          <Link
            to="/libraries/$key/stale"
            params={{ key: lib.key }}
            className="flex items-center gap-3 min-w-0 flex-1"
          >
            <LibraryIcon type={lib.type} />
            <div className="min-w-0">
              <h2 className="font-semibold truncate">{lib.title}</h2>
              <p className="text-xs text-base-content/40 capitalize">
                {lib.type}
              </p>
            </div>
          </Link>
          <button
            className="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/40 hover:text-base-content"
            onClick={onSync}
            disabled={disabled}
            title="Sync this library"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
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
          <span className="badge badge-info gap-1">
            <span className="loading loading-spinner loading-xs" /> pending
          </span>
        )}
        {sync.status === "success" && (
          <span className="badge badge-success gap-1">
            <CheckCircle className="w-3 h-3" /> success
          </span>
        )}
        {sync.status === "error" && (
          <span className="badge badge-error gap-1" title={sync.error ?? ""}>
            <AlertCircle className="w-3 h-3" /> error
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
