import type { DownloadCleanupPreviewResponse } from "../../../../shared/types.ts";

export const SONARR_OWNED_PATH_COPY =
  "Applies the shown Sonarr change and removes its verified historical import links. Active qBittorrent payloads are retained unless qBittorrent is also selected.";

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
  preview: DownloadCleanupPreviewResponse | undefined,
): boolean {
  return preview?.coordinatedConfigured !== false;
}

export function effectiveArrSelection(
  selected: boolean,
  preview: DownloadCleanupPreviewResponse | undefined,
): boolean {
  return selected && shouldUseArrByDefault(preview);
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
  allowOrphanOnly = false,
): boolean {
  return preview?.items.some((item) =>
    item.status === "resolved" &&
    ((allowOrphanOnly && (item.orphanFiles?.length ?? 0) > 0) ||
      (preview.downloadClientsConfigured === true && item.downloadJobs.length > 0))
  ) ?? false;
}

export function eligibleDownloadCleanupItems(
  preview: DownloadCleanupPreviewResponse | undefined,
  allowOrphanOnly: boolean,
  coordinateArr: boolean,
) {
  return preview?.items.filter((item) =>
    item.status === "resolved" &&
    (item.downloadJobs.length > 0 ||
      (allowOrphanOnly && coordinateArr && item.orphanFiles.length > 0))
  ) ?? [];
}

/**
 * Whole-show Sonarr deletion can reclaim an orphaned import hardlink even after
 * its download job has disappeared. Default only that narrow cleanup case on;
 * a live download job must continue to require an explicit user choice.
 */
export function shouldDefaultOrphanOnlyCleanup(
  preview: DownloadCleanupPreviewResponse | undefined,
): boolean {
  if (!preview) return false;
  const resolved = preview.items.filter((item) => item.status === "resolved");
  return resolved.some((item) =>
    item.downloadJobs.length === 0 && (item.orphanFiles?.length ?? 0) > 0
  ) && resolved.every((item) => item.downloadJobs.length === 0);
}

export function cleanupConsentInvalidated(
  selected: boolean,
  currentAuthorizationKey: string | null,
  acceptedAuthorizationKey: string | null,
): boolean {
  return selected && currentAuthorizationKey !== acceptedAuthorizationKey;
}
