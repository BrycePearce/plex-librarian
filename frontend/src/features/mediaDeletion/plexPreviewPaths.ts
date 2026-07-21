import type { DownloadCleanupPreviewItem } from "../../../../shared/types.ts";
import type { WholeItemDeletionCandidate } from "./types.ts";

export interface PlexPreviewPathEntry {
  item: WholeItemDeletionCandidate;
  path: string;
  note?: string;
}

export function plexPreviewPathEntries(
  items: WholeItemDeletionCandidate[],
  previews: ReadonlyMap<string, DownloadCleanupPreviewItem>,
): PlexPreviewPathEntry[] {
  return items.flatMap((item) => {
    const preview = previews.get(item.ratingKey);
    if (preview?.plexPaths.length) {
      return preview.plexPaths.map((path, index) => ({
        item,
        path,
        note: preview.plexPathsTruncated && index === preview.plexPaths.length - 1
          ? `Showing the first ${preview.plexPaths.length.toLocaleString()} paths reported by Plex; additional paths may be removed`
          : undefined,
      }));
    }
    return [{
      item,
      path: item.title,
      note: preview?.plexPathReason ??
        "Plex did not return an underlying media path",
    }];
  });
}
