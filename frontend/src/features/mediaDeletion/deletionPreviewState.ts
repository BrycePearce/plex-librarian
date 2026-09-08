import type { DownloadCleanupPreviewItem } from "../../../../shared/types.ts";
import type { DownloadCleanupPreviewResponse } from "../../../../shared/types.ts";

export const SONARR_OWNED_PATH_COPY =
  "Applies the shown Sonarr change to current managed files. Identified qBittorrent files are retained unless qBittorrent is also selected.";

export function arrDestinationState(
  preview: DownloadCleanupPreviewResponse | undefined,
) {
  return {
    visible: preview?.coordinatedConfigured === true,
    problems: preview?.items.filter((item) => item.arrStatus !== "resolved") ??
      [],
  };
}

export function shouldUseArrByDefault(
  _preview: DownloadCleanupPreviewResponse | undefined,
): boolean {
  return false;
}

export function effectiveArrSelection(
  selected: boolean,
  preview: DownloadCleanupPreviewResponse | undefined,
): boolean {
  return selected && preview?.coordinatedConfigured !== false;
}

export function selectedSonarrOwnershipProblems(
  preview: DownloadCleanupPreviewResponse | undefined,
  selected: boolean,
) {
  return selected
    ? preview?.items.filter((item) => item.sonarrCleanupStatus === "error") ?? []
    : [];
}

export function downloadCleanupDestinationVisible(
  preview: DownloadCleanupPreviewResponse | undefined,
  _allowOrphanOnly = false,
): boolean {
  return preview?.downloadClientsConfigured === true;
}

export function eligibleDownloadCleanupItems(
  preview: DownloadCleanupPreviewResponse | undefined,
  _allowOrphanOnly: boolean,
  _coordinateArr: boolean,
) {
  return preview?.items.filter((item) =>
    item.status === "resolved" &&
    (item.downloadJobs.length > 0 || item.noJobReason !== undefined)
  ) ?? [];
}

/** Historical cleanup never defaults into a current-location request. */
export function shouldDefaultOrphanOnlyCleanup(
  _preview: DownloadCleanupPreviewResponse | undefined,
): boolean {
  return false;
}

export function cleanupConsentInvalidated(
  selected: boolean,
  currentAuthorizationKey: string | null,
  acceptedAuthorizationKey: string | null,
): boolean {
  return selected && currentAuthorizationKey !== acceptedAuthorizationKey;
}

export function currentLocationOwnershipProblem(
  item: DownloadCleanupPreviewItem,
  sonarrSelected: boolean,
  qbittorrentSelected: boolean,
): { blocked: boolean; reason?: string } {
  const status = sonarrSelected && qbittorrentSelected
    ? item.status
    : sonarrSelected
    ? item.sonarrCleanupStatus
    : qbittorrentSelected
    ? item.qbittorrentOnlyStatus
    : item.plexOnlyStatus;
  const reason = sonarrSelected && qbittorrentSelected
    ? item.reason
    : sonarrSelected
    ? item.sonarrCleanupReason
    : qbittorrentSelected
    ? item.qbittorrentOnlyReason
    : item.plexOnlyReason;
  return { blocked: status !== undefined && status !== "resolved", reason };
}
