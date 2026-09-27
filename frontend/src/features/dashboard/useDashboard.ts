import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api.ts";
import { invalidateGlobalSyncQueries } from "../sync/syncCacheInvalidation.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { useAnyLibrarySyncing, useSyncHistory } from "../../lib/useLibrarySync.tsx";
import { useSyncStream } from "../../lib/useSyncStream.ts";
import { useLocalStorage } from "../../lib/useLocalStorage.ts";

const ARR_ONBOARDING_DISMISSED_KEY = "plex-librarian:arr-onboarding-dismissed";
const QBITTORRENT_ONBOARDING_DISMISSED_KEY = "plex-librarian:qbittorrent-onboarding-dismissed";
const ARR_ONBOARDING_STORAGE = {
  serialize: (value: boolean) => value ? "1" : "0",
  deserialize: (value: string) => value === "1",
};

async function triggerGlobalSyncOrAttach() {
  try {
    return await api.sync.trigger();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.syncId !== undefined) {
      return { syncId: error.syncId, status: "pending" as const };
    }
    throw error;
  }
}

export function useDashboard() {
  const qc = useQueryClient();
  const [arrOnboardingDismissed, setArrOnboardingDismissed] = useLocalStorage(
    ARR_ONBOARDING_DISMISSED_KEY,
    false,
    ARR_ONBOARDING_STORAGE,
  );
  const [qbittorrentOnboardingDismissed, setQbittorrentOnboardingDismissed] = useLocalStorage(
    QBITTORRENT_ONBOARDING_DISMISSED_KEY,
    false,
    ARR_ONBOARDING_STORAGE,
  );
  const [activeGlobalSyncId, setActiveGlobalSyncId] = useState<number | null>(
    null,
  );

  const {
    data: librariesData,
    isLoading: libsLoading,
    error: libsError,
    refetch: refetchLibraries,
    isRefetching: isRefetchingLibraries,
  } = useQuery({
    queryKey: queryKeys.libraries.all,
    queryFn: () => api.libraries.list(),
    // The initial `retry: 1` (see main.tsx) exhausts almost immediately, so without this
    // a dead backend (e.g. killed during local dev) leaves the error banner stuck until
    // something else happens to trigger a refetch (window refocus, manual reload). Poll
    // in the background while erroring so the banner clears itself once the server's back.
    refetchInterval: (query) => query.state.status === "error" ? 5_000 : false,
  });
  const [librariesBannerDismissed, setLibrariesBannerDismissed] = useState(
    false,
  );
  useEffect(() => {
    setLibrariesBannerDismissed(false);
  }, [libsError === null]);
  const { data: arrSettings } = useQuery({
    queryKey: queryKeys.arrIntegrations.all,
    queryFn: api.arr.get,
  });
  const { data: qbittorrentSettings } = useQuery({
    queryKey: queryKeys.qbittorrentIntegrations.all,
    queryFn: api.qbittorrent.get,
  });
  const {
    data: mediaRemovalSummary,
    isLoading: isMediaRemovalSummaryLoading,
  } = useQuery({
    queryKey: queryKeys.mediaRemovals.summary,
    queryFn: api.mediaRemovals.summary,
  });

  const triggerSync = useMutation({
    mutationFn: triggerGlobalSyncOrAttach,
    onSuccess: (data) => {
      setActiveGlobalSyncId(data.syncId);
      void qc.invalidateQueries({ queryKey: queryKeys.sync.history });
    },
  });

  const anyLibrarySyncing = useAnyLibrarySyncing();

  const { data: history, isLoading: isHistoryLoading } = useSyncHistory();

  // Re-attach to a pending global sync after a page refresh.
  useEffect(() => {
    if (activeGlobalSyncId !== null) return;
    const pending = history?.find((h) => h.status === "pending" && h.libraryKey === null);
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
  const lastSyncedAt = librariesData?.libraries.reduce(
    (latest, library) => Math.max(latest, library.syncedAt),
    0,
  ) ?? 0;

  // Whether this is a first sync is ambiguous until `history` has loaded (both signals
  // below depend on it). Only holds up rendering while there's nothing real to show yet
  // (no libraries, or none with items) — a returning user whose libraries already loaded
  // shouldn't wait on history just to render their populated grid.
  const hasAnyImportedItems = librariesData?.libraries.some((lib) => lib.itemCount > 0) ?? false;
  const isCheckingFirstRun = librariesData !== undefined &&
    !hasAnyImportedItems &&
    isHistoryLoading;

  // Whether *this server* has ever completed a successful sync before — the only signal
  // that's stable regardless of how fast an individual library's own sync happens to
  // finish. Checking current item counts instead (an earlier attempt at this) races
  // against the very sync being checked: syncLibrary upserts a library's row before it
  // starts fetching that library's items, and small/fast libraries (e.g. Music) can
  // already have real synced items within the first second while much larger ones are
  // still empty — so "does anything have items yet" can flip false→true well before the
  // overall sync is anywhere close to done, prematurely leaving first-run mode. A
  // server's `history` only gains a 'success' row once a *whole* sync run completes, so
  // this stays accurate for the entire duration regardless of per-library speed.
  const hasEverSyncedSuccessfully = history?.some((h) => h.status === "success") ?? false;
  const hasVideoLibraries =
    librariesData?.libraries.some((library) =>
      library.type === "movie" || library.type === "show"
    ) ?? false;
  // `history` is capped to the 10 most-recent sync_log rows, so a server that succeeded
  // long ago but has had 10+ consecutive recent failures would otherwise read as
  // "never synced" here. `hasAnyImportedItems` is cap-proof — real items in the DB are
  // definitive proof this server has synced before, regardless of what recent history
  // shows — so it's checked alongside `hasEverSyncedSuccessfully` rather than relying on
  // the (bounded) history query alone.
  const isFirstRun = librariesData !== undefined &&
    !hasAnyImportedItems &&
    !hasEverSyncedSuccessfully &&
    isAnySyncing;

  // Library data is the only unconditional blocker. Once an empty library response has
  // established that this might be a first run, let the dedicated checking/first-run
  // states render instead of flashing the populated-dashboard skeleton. Ancillary stats
  // such as media removed are not used by FirstRunHero and must not hold it up.
  const isDashboardLoading = libsLoading ||
    (!isCheckingFirstRun &&
      !isFirstRun &&
      (isHistoryLoading || isMediaRemovalSummaryLoading));

  const showArrOnboarding = !arrOnboardingDismissed &&
    arrSettings !== undefined &&
    arrSettings.instances.length === 0 &&
    hasVideoLibraries &&
    (hasEverSyncedSuccessfully || hasAnyImportedItems);
  const showQbittorrentOnboarding = !qbittorrentOnboardingDismissed &&
    qbittorrentSettings !== undefined &&
    qbittorrentSettings.instances.length === 0 &&
    hasVideoLibraries &&
    (hasEverSyncedSuccessfully || hasAnyImportedItems);

  function dismissArrOnboarding() {
    setArrOnboardingDismissed(true);
  }

  function dismissQbittorrentOnboarding() {
    setQbittorrentOnboardingDismissed(true);
  }

  useEffect(() => {
    if (activeGlobalSyncId === null) return;
    if (!globalSyncDone && globalSyncError === null) return;
    // This component already knows the sync id returned by the trigger endpoint, so it
    // remains the authoritative completion fallback for very fast runs. The root cache
    // coordinator still covers runs that outlive navigation away from the dashboard.
    // Both observers share completion deduplication so they do not refetch the same
    // active queries twice for a single completed run.
    void invalidateGlobalSyncQueries(qc, activeGlobalSyncId, globalSyncDone);
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

  return {
    librariesData,
    libsLoading,
    libsError,
    refetchLibraries,
    isRefetchingLibraries,
    librariesBannerDismissed,
    setLibrariesBannerDismissed,
    mediaRemovalSummary,
    triggerSync,
    activeGlobalSyncId,
    globalSyncProgress,
    globalSyncDone,
    globalSyncError,
    isSyncing,
    isAnySyncing,
    lastSyncedAt,
    isDashboardLoading,
    isCheckingFirstRun,
    isFirstRun,
    showArrOnboarding,
    showQbittorrentOnboarding,
    dismissArrOnboarding,
    dismissQbittorrentOnboarding,
    history,
  };
}
