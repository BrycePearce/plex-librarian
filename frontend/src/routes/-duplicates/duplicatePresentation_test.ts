import { assertEquals } from "@std/assert";
import type { DuplicateGroup, MediaVersion } from "../../lib/api.ts";
import {
  duplicatePageSummary,
  reclaimableKilobytes,
  versionQualityLabels,
} from "./duplicatePresentation.ts";
import { compareDuplicateVersions } from "@shared/mediaComparison";

function version(
  mediaId: number,
  fileSize: number | null,
  videoResolution: string | null = null,
): MediaVersion {
  return {
    mediaId,
    videoResolution,
    width: null,
    height: null,
    duration: null,
    bitrate: null,
    videoCodec: null,
    videoProfile: null,
    videoBitDepth: null,
    videoDynamicRange: null,
    videoFrameRate: null,
    videoScanType: null,
    container: null,
    audioCodec: null,
    audioChannels: null,
    audioProfile: null,
    audioStreams: [],
    subtitleStreams: [],
    streamDetailsAvailable: false,
    fileSize,
  };
}

function detailedVersion(
  mediaId: number,
  overrides: Partial<MediaVersion> = {},
): MediaVersion {
  return {
    ...version(mediaId, 1_000, "1080"),
    width: 1920,
    height: 1080,
    duration: 7_200_000,
    bitrate: 8_000,
    videoCodec: "h264",
    videoProfile: "high",
    videoBitDepth: 8,
    container: "mkv",
    audioCodec: "aac",
    audioChannels: 6,
    audioStreams: [{
      codec: "aac",
      language: "eng",
      channels: 6,
      channelLayout: "5.1",
      title: null,
      forced: false,
      default: true,
    }],
    streamDetailsAvailable: true,
    ...overrides,
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

Deno.test("comparison identifies a matching technical profile without claiming exactness", () => {
  assertEquals(
    compareDuplicateVersions([detailedVersion(1), detailedVersion(2)]),
    {
      kind: "same-profile",
      label: "Same technical profile",
      reasons: [
        "Plex reports matching runtime, video, and audio characteristics",
      ],
    },
  );
});

Deno.test("comparison can match complete core metadata when Plex omits stream arrays", () => {
  assertEquals(
    compareDuplicateVersions([
      detailedVersion(1, { audioStreams: [], streamDetailsAvailable: false }),
      detailedVersion(2, { audioStreams: [], streamDetailsAvailable: false }),
    ]),
    {
      kind: "same-profile",
      label: "Same technical profile",
      reasons: [
        "Plex reports matching runtime, video, and audio characteristics",
      ],
    },
  );
});

Deno.test("comparison reports meaningful video, runtime, and audio differences", () => {
  assertEquals(
    compareDuplicateVersions([
      detailedVersion(1),
      detailedVersion(2, {
        videoResolution: "4k",
        width: 3840,
        height: 2160,
        duration: 7_260_000,
        bitrate: 24_000,
        videoDynamicRange: "HDR10",
        audioCodec: "truehd",
        audioChannels: 8,
      }),
    ]),
    {
      kind: "different",
      label: "Meaningful differences",
      reasons: [
        "Resolution differs",
        "Bitrate differs",
        "Runtime differs",
        "Audio tracks differ",
      ],
    },
  );
});

Deno.test("comparison flags frame rate and interlacing differences", () => {
  assertEquals(
    compareDuplicateVersions([
      detailedVersion(1, {
        videoFrameRate: "23.976p",
        videoScanType: "progressive",
      }),
      detailedVersion(2, {
        videoFrameRate: "25p",
        videoScanType: "interlaced",
      }),
    ]),
    {
      kind: "different",
      label: "Meaningful differences",
      reasons: ["Frame rate differs", "Interlacing differs"],
    },
  );
});

Deno.test("comparison remains unknown when Plex metadata is sparse", () => {
  assertEquals(compareDuplicateVersions([version(1, 10), version(2, 10)]), {
    kind: "unknown",
    label: "Needs review",
    reasons: [
      "Plex did not report enough technical metadata to compare safely",
    ],
  });
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
