import { assertEquals } from "@std/assert";
import type { DownloadCleanupPreviewItem } from "../../../../shared/types.ts";
import type { WholeItemDeletionCandidate } from "./types.ts";
import { plexPreviewPathEntries } from "./plexPreviewPaths.ts";

const item = {
  ratingKey: "1",
  libraryKey: "movies",
  title: "Movie",
  type: "movie",
  fileSize: null,
} satisfies WholeItemDeletionCandidate;
const basePreview = {
  ratingKey: "1",
  plexPaths: [],
  plexPathStatus: "resolved",
  plexPathReason: undefined,
  plexPathsTruncated: false,
  status: "unavailable",
  downloadJobs: [],
  arrStatus: "unavailable",
  arrTargets: [],
  sources: [],
  orphanFiles: [],
  retainedPaths: [],
} as DownloadCleanupPreviewItem;

Deno.test("Plex preview expands every Media Part path without normalizing it", () => {
  const previews = new Map([["1", {
    ...basePreview,
    plexPaths: [
      "C:\\Media\\Movie.mkv",
      "\\\\nas\\Movies\\Movie.mkv",
      "/media/Movie.mkv",
    ],
  }]]);
  assertEquals(
    plexPreviewPathEntries([item], previews).map(({ path }) => path),
    ["C:\\Media\\Movie.mkv", "\\\\nas\\Movies\\Movie.mkv", "/media/Movie.mkv"],
  );
});

Deno.test("Plex preview retains an explicit reason when no path is available", () => {
  const previews = new Map([["1", {
    ...basePreview,
    plexPaths: [],
    plexPathStatus: "unavailable" as const,
    plexPathReason: "Plex did not return an underlying media path",
  }]]);
  assertEquals(plexPreviewPathEntries([item], previews)[0], {
    item,
    path: "Movie",
    note: "Plex did not return an underlying media path",
  });
});
