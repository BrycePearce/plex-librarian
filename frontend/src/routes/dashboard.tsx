import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Variants } from "motion/react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  ChevronDown,
  Clock,
  Copy,
  Database,
  Download,
  Film,
  HardDrive,
  Info,
  Library as LibraryGlyph,
  Music,
  PlugZap,
  RefreshCw,
  Trash2,
  Tv,
  Users,
  X,
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
  useSyncHistory,
} from "../lib/useLibrarySync";
import { useSyncStream } from "../lib/useSyncStream";
import { useLocalStorage } from "../lib/useLocalStorage";
import { requireAuth } from "../lib/requireAuth";
import { DashboardSkeleton } from "../components/Skeletons";
import "./dashboard.css";
import { SectionHeading } from "../components/Workspace";

// Shared orchestration for the stats strip and library grid: the container just declares
// the stagger timing, each child only needs `variants={cardVariants}` to inherit the
// hidden → show transition from whichever container it's mounted under.
const containerVariants: Variants = {
  hidden: { opacity: 1 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.025 },
  },
};

const pageVariants: Variants = {
  hidden: { opacity: 0, y: 7 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.26, ease: "easeOut" },
  },
};

const pageSectionVariants: Variants = {
  hidden: { opacity: 1, y: 0 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease: "easeOut" },
  },
};

const cardVariants: Variants = {
  hidden: { opacity: 0.72, y: 4 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease: "easeOut" },
  },
};

const ARR_ONBOARDING_DISMISSED_KEY = "plex-librarian:arr-onboarding-dismissed";
const QBITTORRENT_ONBOARDING_DISMISSED_KEY =
  "plex-librarian:qbittorrent-onboarding-dismissed";
const ARR_ONBOARDING_STORAGE = {
  serialize: (value: boolean) => value ? "1" : "0",
  deserialize: (value: string) => value === "1",
};

export const Route = createFileRoute("/dashboard")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
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
function DashboardInner() {
  const qc = useQueryClient();
  const [arrOnboardingDismissed, setArrOnboardingDismissed] = useLocalStorage(
    ARR_ONBOARDING_DISMISSED_KEY,
    false,
    ARR_ONBOARDING_STORAGE,
  );
  const [qbittorrentOnboardingDismissed, setQbittorrentOnboardingDismissed] =
    useLocalStorage(
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
    queryKey: ["libraries"],
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
    queryKey: ["arr-integrations"],
    queryFn: api.arr.get,
  });
  const { data: qbittorrentSettings } = useQuery({
    queryKey: ["qbittorrent-integrations"],
    queryFn: api.qbittorrent.get,
  });
  const {
    data: mediaRemovalSummary,
    isLoading: isMediaRemovalSummaryLoading,
  } = useQuery({
    queryKey: ["media-removals", "summary"],
    queryFn: api.mediaRemovals.summary,
  });

  const triggerSync = useMutation({
    mutationFn: () => api.sync.trigger(),
    onSuccess: (data) => {
      setActiveGlobalSyncId(data.syncId);
      void qc.invalidateQueries({ queryKey: ["sync", "history"] });
    },
  });

  const anyLibrarySyncing = useAnyLibrarySyncing();

  const { data: history, isLoading: isHistoryLoading } = useSyncHistory();
  const isDashboardLoading = libsLoading || isHistoryLoading ||
    isMediaRemovalSummaryLoading;

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
  const lastSyncedAt = librariesData?.libraries.reduce(
    (latest, library) => Math.max(latest, library.syncedAt),
    0,
  ) ?? 0;

  // Whether this is a first sync is ambiguous until `history` has loaded (both signals
  // below depend on it). Only holds up rendering while there's nothing real to show yet
  // (no libraries, or none with items) — a returning user whose libraries already loaded
  // shouldn't wait on history just to render their populated grid.
  const hasAnyImportedItems =
    librariesData?.libraries.some((lib) => lib.itemCount > 0) ?? false;
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
  const hasEverSyncedSuccessfully =
    history?.some((h) => h.status === "success") ?? false;
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
    void qc.invalidateQueries({ queryKey: ["libraries"] });
    void qc.invalidateQueries({ queryKey: ["users"] });
    void qc.invalidateQueries({ queryKey: ["sync", "history"] });
    void qc.invalidateQueries({ queryKey: ["events"] });
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
    <div className="dashboard-page space-y-6">
      <header className="dashboard-header">
        <div className="dashboard-heading">
          <div className="dashboard-eyebrow">
            <span className="dashboard-live-dot" /> Library intelligence
          </div>
          <h1>Home</h1>
          <p>
            {!isDashboardLoading && !isCheckingFirstRun && librariesData
              ? isFirstRun
                ? "First sync in progress…"
                : `Your library health, priorities, and next best actions.`
              : "Your library health, priorities, and next best actions."}
          </p>
        </div>
        <div className="dashboard-header-actions">
          {!isAnySyncing && !isDashboardLoading && (
            <span className="dashboard-health">
              <CheckCircle className="size-4" />
              {lastSyncedAt
                ? `Synced ${formatRelativeTime(lastSyncedAt)}`
                : "Ready to sync"}
            </span>
          )}
          <button
            type="button"
            className="btn btn-primary dashboard-sync-button"
            onClick={() => triggerSync.mutate()}
            disabled={isAnySyncing || isDashboardLoading}
          >
            <RefreshCw
              className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
            />
            {isSyncing ? "Syncing…" : "Sync all"}
          </button>
        </div>
      </header>

      {libsError && !librariesBannerDismissed && (
        <div className="alert alert-error items-start">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p>Failed to load libraries</p>
            <p className="text-xs opacity-70">
              {libsError instanceof Error ? libsError.message : "Unknown error"}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => void refetchLibraries()}
            disabled={isRefetchingLibraries}
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${
                isRefetchingLibraries ? "animate-spin" : ""
              }`}
            />
            Retry
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square"
            onClick={() => setLibrariesBannerDismissed(true)}
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {isDashboardLoading && <DashboardSkeleton />}
      {!isDashboardLoading && (
        <motion.div
          className="dashboard-content-sequence space-y-6"
          variants={pageVariants}
          initial="hidden"
          animate="show"
        >
          {showArrOnboarding && (
            <motion.aside
              className="arr-onboarding-nudge"
              variants={pageSectionVariants}
              aria-label="Sonarr and Radarr setup"
            >
              <span className="arr-onboarding-icon">
                <PlugZap className="size-4" />
              </span>
              <span className="arr-onboarding-copy">
                <strong>Using Sonarr or Radarr?</strong>
                <span>
                  Connect your media managers so whole-title deletion can be
                  coordinated safely.
                </span>
              </span>
              <Link
                to="/settings/sonarr-radarr"
                className="btn btn-primary btn-sm arr-onboarding-setup"
              >
                Set up integrations
              </Link>
              <button
                type="button"
                className="arr-onboarding-dismiss"
                onClick={dismissArrOnboarding}
                aria-label="Don't show Sonarr and Radarr setup again"
                title="Don't show again"
              >
                <X className="size-4" />
                <span>Don&apos;t show again</span>
              </button>
            </motion.aside>
          )}

          {showQbittorrentOnboarding && (
            <motion.aside
              className="arr-onboarding-nudge"
              variants={pageSectionVariants}
              aria-label="qBittorrent setup"
            >
              <span className="arr-onboarding-icon">
                <Download className="size-4" />
              </span>
              <span className="arr-onboarding-copy">
                <strong>Using qBittorrent?</strong>
                <span>
                  Connect it to inspect torrent metadata and optionally remove
                  verified download payloads during coordinated deletion.
                </span>
              </span>
              <Link
                to="/settings/sonarr-radarr"
                className="btn btn-primary btn-sm arr-onboarding-setup"
              >
                Set up qBittorrent
              </Link>
              <button
                type="button"
                className="arr-onboarding-dismiss"
                onClick={dismissQbittorrentOnboarding}
                aria-label="Don't show qBittorrent setup again"
                title="Don't show again"
              >
                <X className="size-4" />
                <span>Don&apos;t show again</span>
              </button>
            </motion.aside>
          )}

          {!libsLoading && librariesData &&
            librariesData.libraries.length > 0 && (
            <StatsStrip
              libraries={librariesData.libraries}
              mediaSizeRemoved={mediaRemovalSummary?.mediaSizeRemoved ?? 0}
            />
          )}

          {!libsLoading && librariesData &&
            librariesData.libraries.length > 0 && (
            <HomeDirectory libraries={librariesData.libraries} />
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

          {
            /* Suppressed during isFirstRun only — FirstRunHero already shows its own inline
          progress, so showing this panel too would be a duplicate. It stays visible
          while isCheckingFirstRun, since that state has no progress display of its own. */
          }
          {!isFirstRun && (
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
          )}

          {!libsLoading && (isCheckingFirstRun
            ? (
              // Neutral spinner rather than a content-shaped skeleton: we already know
              // there's nothing with items yet, just not yet whether that means "first sync
              // in progress" or "genuinely empty" — a grid of card skeletons would wrongly
              // imply libraries are about to appear right before it flips to the first-run
              // hero instead.
              <div className="flex justify-center py-16">
                <span className="loading loading-ring w-10 text-primary" />
              </div>
            )
            : isFirstRun
            ? <FirstRunHero progress={globalSyncProgress ?? undefined} />
            : (
              <>
                {history && history.length > 0 && (
                  <motion.section
                    className="dashboard-panel sync-history-panel"
                    variants={pageSectionVariants}
                  >
                    <div className="dashboard-panel-header">
                      <SectionHeading
                        eyebrow="Operations"
                        title="Recent syncs"
                        meta={
                          <Link to="/activity" className="dashboard-panel-link">
                            View activity <ArrowRight className="size-4" />
                          </Link>
                        }
                      />
                    </div>
                    <div className="overflow-x-auto sync-history-table">
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
                          {history.slice(0, 3).map((s) => (
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
                  </motion.section>
                )}
              </>
            ))}
        </motion.div>
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

function StatsStrip({
  libraries,
  mediaSizeRemoved,
}: {
  libraries: Library[];
  mediaSizeRemoved: number;
}) {
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
  const animatedRemovedSize = useCountUp(mediaSizeRemoved, 900);

  return (
    <motion.div
      variants={containerVariants}
      className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"
    >
      <StatTile
        icon={<Database className="w-5 h-5" />}
        iconClass="bg-primary/20 text-primary"
        tone="primary"
        label="Total items"
        value={animatedItems.toLocaleString()}
      />
      <StatTile
        icon={<HardDrive className="w-5 h-5" />}
        iconClass="bg-secondary/20 text-secondary"
        tone="secondary"
        label="Library size"
        value={formatKilobytes(animatedSize)}
      />
      <StatTile
        icon={<Trash2 className="w-5 h-5" />}
        iconClass="bg-primary/20 text-primary"
        tone="primary"
        label="Media removed"
        value={formatKilobytes(animatedRemovedSize)}
      />
      <StatTile
        icon={<Clock className="w-5 h-5" />}
        iconClass="bg-accent/20 text-accent"
        tone="accent"
        label="Last synced"
        value={totals.lastSync ? formatRelativeTime(totals.lastSync) : "—"}
      />
    </motion.div>
  );
}

function HomeDirectory({ libraries }: { libraries: Library[] }) {
  const [showAllLibraries, setShowAllLibraries] = useState(false);
  const visibleLibraries = showAllLibraries ? libraries : libraries.slice(0, 6);
  const sections = [
    {
      index: "02",
      to: "/duplicates" as const,
      icon: Copy,
      tone: "accent",
      label: "Versions",
      title: "Duplicates",
      detail: "Compare multiple synced versions of movies and episodes.",
      cta: "Open duplicates",
      search: { type: "all" as const },
    },
    {
      index: "03",
      to: "/users" as const,
      icon: Users,
      tone: "primary",
      label: "Viewing",
      title: "Users",
      detail: "Explore viewing history and activity across Plex users.",
      cta: "Open users",
      search: { filter: "all" as const },
    },
  ];

  return (
    <motion.section
      className="home-directory"
      variants={pageSectionVariants}
    >
      <SectionHeading eyebrow="Workspace" title="Explore Plex Librarian" />
      <motion.div
        className="home-directory-list"
        variants={containerVariants}
      >
        <motion.div
          variants={cardVariants}
          className="home-stale-section home-collection-section"
        >
          <div className="home-stale-heading">
            <span className="home-directory-index">01</span>
            <span className="home-directory-icon">
              <LibraryGlyph className="size-5" />
            </span>
            <span className="home-directory-copy">
              <small>Collection</small>
              <strong>Libraries</strong>
              <span>
                Select a library to review stale and unwatched content.
              </span>
            </span>
            <span className="home-collection-count">
              {libraries.length} active
            </span>
          </div>
          <div className="home-stale-libraries">
            {visibleLibraries.map((library) => (
              <Link
                key={library.key}
                to="/libraries/$key/stale"
                params={{ key: library.key }}
                className={`home-stale-library home-library-${library.type}`}
              >
                <LibraryIcon type={library.type} />
                <span className="home-library-name">
                  <strong>{library.title}</strong>
                  <small>
                    {library.itemCount.toLocaleString()} items ·{" "}
                    {formatKilobytes(library.totalFileSize)}
                  </small>
                </span>
                {library.historySyncedAt === null && (
                  <i title="Watch history is still syncing" />
                )}
                <ArrowRight className="size-3.5" />
              </Link>
            ))}
            {libraries.length > 6 && (
              <button
                type="button"
                className="home-library-more"
                onClick={() => setShowAllLibraries((value) => !value)}
              >
                <ChevronDown
                  className={`size-4 ${showAllLibraries ? "rotate-180" : ""}`}
                />
                {showAllLibraries
                  ? "Show fewer"
                  : `Show ${libraries.length - 6} more`}
              </button>
            )}
          </div>
        </motion.div>
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <motion.div key={section.to} variants={cardVariants}>
              <Link
                to={section.to}
                search={"search" in section ? section.search : undefined}
                className={`home-directory-section home-directory-${section.tone}`}
              >
                <span className="home-directory-index">{section.index}</span>
                <span className="home-directory-icon">
                  <Icon className="size-5" />
                </span>
                <span className="home-directory-copy">
                  <small>{section.label}</small>
                  <strong>{section.title}</strong>
                  <span>{section.detail}</span>
                </span>
                <span className="home-directory-cta">
                  {section.cta} <ArrowRight className="size-4" />
                </span>
              </Link>
            </motion.div>
          );
        })}
      </motion.div>
    </motion.section>
  );
}

function StatTile({
  icon,
  iconClass,
  tone,
  label,
  value,
}: {
  icon: ReactNode;
  iconClass: string;
  tone: "primary" | "secondary" | "accent";
  label: string;
  value: string;
}) {
  return (
    <motion.div
      variants={cardVariants}
      className={`dashboard-stat-card dashboard-stat-${tone}`}
    >
      <div className="dashboard-stat-content">
        <div
          className={`dashboard-stat-icon ${iconClass}`}
        >
          {icon}
        </div>
        <div className="dashboard-stat-copy">
          <p>{label}</p>
          <strong>{value}</strong>
        </div>
      </div>
    </motion.div>
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

function FirstRunHero({ progress }: { progress?: LibrarySyncProgress[] }) {
  const totalItems = progress?.reduce((sum, l) => sum + l.count, 0) ?? 0;
  const animatedTotal = useCountUp(totalItems, 800);
  const doneCount = progress?.filter((l) => l.phase === "done").length ?? 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
      className="card bg-base-200 shadow-xl"
    >
      <div className="card-body items-center text-center gap-6 py-14">
        <div className="w-14 h-14 rounded-2xl bg-primary/15 text-primary flex items-center justify-center">
          <LibraryGlyph className="w-7 h-7" />
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="card-title text-2xl justify-center">
            Importing your libraries
          </h2>
          <p className="text-base-content/60 max-w-md">
            This first sync pulls everything from Plex, so it can take a few
            minutes on large libraries.
          </p>
        </div>

        {progress?.length
          ? (
            <div className="w-full max-w-sm flex flex-col gap-2.5 text-left">
              {progress.map((lib) => (
                <LibraryProgressRow key={lib.key} lib={lib} />
              ))}
              <div className="text-xs text-base-content/40 text-center pt-1">
                {doneCount} of {progress.length} libraries done ·{" "}
                {animatedTotal.toLocaleString()} items so far
              </div>
            </div>
          )
          : <span className="loading loading-ring w-12 text-primary" />}
      </div>
    </motion.div>
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
    <tr className="sync-history-row">
      <td>
        {sync.status === "pending" && (
          <span className="badge badge-info gap-1 min-w-22 justify-center leading-none">
            <span className="loading loading-spinner loading-xs" /> pending
          </span>
        )}
        {sync.status === "success" && (
          <span className="badge dashboard-success-badge gap-1 min-w-22 justify-center leading-none">
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
