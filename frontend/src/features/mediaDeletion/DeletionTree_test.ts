import { assertEquals } from "@std/assert";
import type { DownloadCleanupPreviewItem } from "@shared/types";
import {
  wholeItemOrphanFiles,
  wholeItemRetainedPaths,
  wholeItemSonarrHistoricalPaths,
} from "./DeletionTree.tsx";
import { sonarrRetainedPathsSummary } from "./SonarrRetainedPathsWarning.tsx";

Deno.test("whole-show dialog wiring switches only the qBittorrent ownership projection", () => {
  const sonarrOnly = [{
    path: "/downloads/episode.mkv",
    managedPath: "/library/episode.mkv",
    size: 100,
    disposition: "retain_live_qbittorrent" as const,
    reason: "live owner",
  }];
  const withQbittorrent = [{
    ...sonarrOnly[0],
    disposition: "delete" as const,
    reason: "selected owner",
  }];
  const preview = {
    sonarrHistoricalPaths: sonarrOnly,
    qbittorrentSonarrHistoricalPaths: withQbittorrent,
  } as DownloadCleanupPreviewItem;

  assertEquals(wholeItemSonarrHistoricalPaths("movie", preview, true, false), []);
  assertEquals(wholeItemSonarrHistoricalPaths("show", preview, false, false), []);
  assertEquals(wholeItemSonarrHistoricalPaths("show", preview, true, false), sonarrOnly);
  assertEquals(wholeItemSonarrHistoricalPaths("show", preview, true, true), withQbittorrent);
  assertEquals(
    sonarrRetainedPathsSummary(wholeItemSonarrHistoricalPaths("show", preview, true, false))?.count,
    1,
  );
  assertEquals(
    sonarrRetainedPathsSummary(wholeItemSonarrHistoricalPaths("show", preview, true, true)),
    null,
  );
});

Deno.test("qBittorrent-only show preview hides Sonarr historical path effects", () => {
  const preview = {
    status: "resolved",
    orphanFiles: [{ path: "/downloads/history.mkv", size: 100, method: "hardlink" }],
    retainedPaths: [{ path: "/downloads/retained.mkv", reason: "live owner" }],
  } as DownloadCleanupPreviewItem;

  assertEquals(wholeItemOrphanFiles("show", preview, false, true), []);
  assertEquals(wholeItemRetainedPaths("show", preview, false, true), []);
  assertEquals(wholeItemOrphanFiles("movie", preview, false, true), preview.orphanFiles);
});
