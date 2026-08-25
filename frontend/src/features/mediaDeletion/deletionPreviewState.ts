import type { DownloadCleanupPreviewResponse } from "../../../../shared/types.ts";

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
