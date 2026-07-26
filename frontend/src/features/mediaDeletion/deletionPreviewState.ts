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
