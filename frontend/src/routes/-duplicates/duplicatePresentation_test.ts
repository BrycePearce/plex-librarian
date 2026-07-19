import { assertEquals } from "@std/assert";
import type { DuplicateGroup, MediaVersion } from "../../lib/api.ts";
import {
  duplicatePageSummary,
  reclaimableKilobytes,
  versionQualityLabels,
} from "./duplicatePresentation.ts";

function version(
  mediaId: number,
  fileSize: number | null,
  videoResolution: string | null = null,
): MediaVersion {
  return {
    mediaId,
    videoResolution,
    bitrate: null,
    videoCodec: null,
    container: null,
    fileSize,
  };
}

Deno.test("reclaimableKilobytes keeps the largest version", () => {
  assertEquals(
    reclaimableKilobytes([version(1, 10), version(2, 30), version(3, 20)]),
    30,
  );
});

Deno.test("reclaimableKilobytes stays unknown when a size is missing", () => {
  assertEquals(reclaimableKilobytes([version(1, 10), version(2, null)]), null);
});

Deno.test("versionQualityLabels deduplicates and limits resolutions", () => {
  assertEquals(
    versionQualityLabels([
      version(1, 1, "4k"),
      version(2, 1, "1080"),
      version(3, 1, "4K"),
      version(4, 1, "720"),
      version(5, 1, "sd"),
    ]),
    { labels: ["4K", "1080", "720"], remaining: 1 },
  );
});

Deno.test("duplicatePageSummary does not present partial storage as a total", () => {
  const knownGroup: DuplicateGroup = {
    mediaType: "movie",
    libraryKey: "1",
    ratingKey: "10",
    title: "Known",
    year: null,
    thumb: null,
    combinedFileSize: 30,
    versions: [version(1, 10), version(2, 20)],
  };
  const unknownGroup: DuplicateGroup = {
    ...knownGroup,
    ratingKey: "11",
    title: "Unknown",
    combinedFileSize: null,
    versions: [version(3, 10), version(4, null)],
  };

  assertEquals(duplicatePageSummary([knownGroup, unknownGroup]), {
    versionCount: 4,
    storageKilobytes: null,
    reclaimableKilobytes: null,
  });
});
