import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "./api";
import { useSyncStream } from "./useSyncStream";

// A "Sync all" run finishing many libraries in a burst (small ones like Music/Podcasts
// often land within milliseconds of each other) would otherwise fire one invalidate per
// library — cheap at 6 libraries, needlessly repeated at 100. Each library's own
// useLibrarySync calls these independently, so the coalescing window has to live at
// module scope (shared across every hook instance) rather than per-hook: whichever call
// arrives first schedules the actual invalidate; any more within the window are no-ops,
// collapsing an arbitrarily large burst into one request regardless of library count.
function makeDebouncedInvalidator(queryKey: readonly unknown[], delayMs = 500) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestQc: QueryClient | null = null;
  return (qc: QueryClient) => {
    latestQc = qc;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void latestQc?.invalidateQueries({ queryKey: [...queryKey] });
    }, delayMs);
  };
}

const debouncedInvalidateLibraries = makeDebouncedInvalidator(["libraries"]);
const debouncedInvalidateSyncHistory = makeDebouncedInvalidator([
  "sync",
  "history",
]);
const debouncedInvalidateEvents = makeDebouncedInvalidator(["events"]);

// Shared across every caller (dashboard's "Recent syncs" list, per-library reattach
// below) so they all read the same cached list instead of each issuing their own fetch.
export function useSyncHistory() {
  return useQuery({
    queryKey: ["sync", "history"],
    queryFn: () => api.sync.history(10),
  });
}

type SyncActions = {
  increment: () => void;
  decrement: () => void;
};

const ActiveSyncActionsContext = createContext<SyncActions>({
  increment: () => {},
  decrement: () => {},
});
const ActiveSyncCountContext = createContext(0);

export function LibrarySyncProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [count, setCount] = useState(0);
  const increment = useCallback(() => setCount((current) => current + 1), []);
  const decrement = useCallback(
    () => setCount((current) => Math.max(0, current - 1)),
    [],
  );
  const actions = useMemo(() => ({ increment, decrement }), [increment, decrement]);

  return (
    <ActiveSyncActionsContext.Provider value={actions}>
      <ActiveSyncCountContext.Provider value={count}>
        {children}
      </ActiveSyncCountContext.Provider>
    </ActiveSyncActionsContext.Provider>
  );
}

export function useAnyLibrarySyncing(): boolean {
  return useContext(ActiveSyncCountContext) > 0;
}

export function useLibrarySync(libraryKey: string) {
  const qc = useQueryClient();
  const { increment, decrement } = useContext(ActiveSyncActionsContext);
  // A pending sync we've attached to is either scoped to just this library (triggered
  // from this page's own "Sync" button, or reattached to one still running after a
  // remount) or a global "Sync all" run (libraryKey: null on the sync_log row) that
  // happens to include this library. The two need different "is this library done yet"
  // logic below, since a global run's overall completion covers every library, not just
  // this one — id and scope always change together, hence one state slot for both.
  const [attached, setAttached] = useState<
    {
      id: number;
      scope: "library" | "global";
    } | null
  >(null);

  const {
    progress,
    isDone,
    error: syncError,
  } = useSyncStream(attached?.id ?? null);

  // A global run's own sync_log row stays 'pending' until every library in it finishes
  // (see the completion effect below), so once *this* library's own portion is done we
  // detach without invalidating that row — otherwise the reattach effect just below
  // would immediately find the same still-pending row again and reattach in a tight
  // loop (each pass re-detects "done" from the unchanged SSE state and re-invalidates
  // ['libraries'], forever). Remembering the id we've already finished with here is
  // what breaks that loop.
  const handledSyncId = useRef<number | null>(null);

  // Re-attach to a sync still pending server-side after this component mounts/remounts
  // (e.g. navigating away mid-sync and back, or opening this library while a "Sync all"
  // triggered from the dashboard is still running) — otherwise `attached` stays null
  // and this hook has no way to know a sync affecting this library is in progress.
  const { data: history, isLoading: isHistoryLoading } = useSyncHistory();
  // Computed directly during render (rather than only inside the effect below) so
  // `isSyncing` already reflects a pending sync the instant `history` loads, instead of
  // waiting one extra render for the effect to run and call `setAttached`. Consumers
  // (e.g. the stale-items page) key a warning-vs-info banner off `isSyncing`; without
  // this, a page refresh could paint the "not syncing" banner for one frame before
  // flipping to "syncing" once the effect catches up.
  const pendingFromHistory = attached === null
    ? history?.find(
      (h) =>
        h.status === "pending" &&
        h.id !== handledSyncId.current &&
        (h.libraryKey === libraryKey || h.libraryKey === null),
    )
    : undefined;
  useEffect(() => {
    if (pendingFromHistory) {
      setAttached({
        id: pendingFromHistory.id,
        scope: pendingFromHistory.libraryKey === null ? "global" : "library",
      });
    }
  }, [pendingFromHistory]);

  // For a global run, this library's SSE progress entry reaching the 'done' phase means
  // *this* library's data is ready — no need to wait for every other library in the run.
  const thisLibraryPhase = progress?.find(
    (lib) => lib.key === libraryKey,
  )?.phase;
  const isThisLibraryDone = attached?.scope === "global"
    ? thisLibraryPhase === "done"
    : isDone;

  useEffect(() => {
    if (attached === null) return;
    if (!isThisLibraryDone && syncError === null) return;
    debouncedInvalidateLibraries(qc);
    // Roster reconciliation runs before every sync, and each completed library history
    // walk can advance users.lastViewedAt, so refresh the Users page as well.
    void qc.invalidateQueries({ queryKey: ["users"] });
    // Not debounced — this key is scoped to this one library, so there's nothing for
    // it to coalesce with, and this is likely the page the user is actually watching.
    void qc.invalidateQueries({ queryKey: ["stale", libraryKey] });
    // A global run's own history-list entry doesn't flip to 'success' until every
    // library finishes, so only invalidate it once the whole thing is actually over.
    // The backend logs its sync.completed/sync.failed activity event on that same
    // whole-run boundary, so the events feed is invalidated on the same condition.
    if (attached.scope !== "global" || isDone || syncError !== null) {
      debouncedInvalidateSyncHistory(qc);
      debouncedInvalidateEvents(qc);
    }
    handledSyncId.current = attached.id;
    setAttached(null);
  }, [isThisLibraryDone, isDone, syncError, attached, libraryKey, qc]);

  const mutation = useMutation({
    mutationFn: () => api.sync.triggerLibrary(libraryKey),
    onSuccess: (data) => {
      setAttached({ id: data.syncId, scope: "library" });
      void qc.invalidateQueries({ queryKey: ["sync", "history"] });
    },
  });

  const isSyncing = (attached !== null && !isThisLibraryDone) ||
    mutation.isPending ||
    pendingFromHistory !== undefined;

  // Register with context so DashboardPage can gate the "Sync all" button. Also the mirror
  // image of the completion effect above: that one invalidates ['stale', libraryKey] once
  // `historySyncedAt` is set back to a real timestamp, but nothing previously invalidated it
  // going the other way when a sync starts and the backend resets `historySyncedAt` to null
  // (see syncLibrary in sync.ts) — so a page that already had this library's stale data
  // cached from before the sync kept showing the pre-sync `historySyncedAt`, and the
  // "watch-history sync running" banner (which keys off `historySyncedAt === null`) silently
  // failed to appear until something else happened to refetch it (e.g. a hard reload).
  const prevSyncing = useRef(false);
  useEffect(() => {
    if (isSyncing && !prevSyncing.current) {
      prevSyncing.current = true;
      increment();
      void qc.invalidateQueries({ queryKey: ["stale", libraryKey] });
    } else if (!isSyncing && prevSyncing.current) {
      prevSyncing.current = false;
      decrement();
    }
  }, [isSyncing, increment, decrement, qc, libraryKey]);

  // Decrement on unmount if still registered as active.
  useEffect(
    () => () => {
      if (prevSyncing.current) decrement();
    },
    [decrement],
  );

  return {
    isSyncing,
    // True only until we've fetched sync history at least once — lets callers hold off
    // rendering a "definitely not syncing" state before that's actually known.
    isSyncStatusLoading: isHistoryLoading,
    trigger: () => mutation.mutate(),
    isError: mutation.isError,
    error: mutation.error,
  };
}
