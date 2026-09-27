import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, CheckCircle, Download, PlugZap, RefreshCw, X } from "lucide-react";
import { formatRelativeTime } from "../../lib/format.ts";
import { LibrarySyncProvider } from "../../lib/useLibrarySync.tsx";
import { DashboardSkeleton } from "../../components/Skeletons.tsx";
import { pageSectionVariants, pageVariants } from "./animation.ts";
import { HomeDirectory } from "./HomeDirectory.tsx";
import { RecentSyncs } from "./RecentSyncs.tsx";
import { StatsStrip } from "./StatsStrip.tsx";
import { FirstRunHero, SyncProgressPanel } from "./SyncProgress.tsx";
import { useDashboard } from "./useDashboard.ts";

export function DashboardPage() {
  return (
    <LibrarySyncProvider>
      <DashboardInner />
    </LibrarySyncProvider>
  );
}

function DashboardInner() {
  const {
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
  } = useDashboard();

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
              {lastSyncedAt ? `Synced ${formatRelativeTime(lastSyncedAt)}` : "Ready to sync"}
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
              className={`w-3.5 h-3.5 ${isRefetchingLibraries ? "animate-spin" : ""}`}
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
                  Connect your media managers so whole-title deletion can be coordinated safely.
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
                  Connect it to inspect torrent metadata and optionally remove verified download
                  payloads during coordinated deletion.
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
                  <RecentSyncs history={history} libraries={librariesData?.libraries ?? []} />
                )}
              </>
            ))}
        </motion.div>
      )}
    </div>
  );
}
