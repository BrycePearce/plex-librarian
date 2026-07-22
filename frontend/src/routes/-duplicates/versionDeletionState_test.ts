import { assertEquals } from "@std/assert";
import type { MediaVersion, VersionDeletionPreviewResponse } from "../../lib/api.ts";
import {
  defaultVersionSelection,
  versionArrDeletionActive,
  versionDeletionExecutionTarget,
  versionDeletionPresentation,
  versionDestinationState,
  versionPlexFallbackRequired,
  versionSelectionSemantics,
} from "./versionDeletionState.ts";

const versions: MediaVersion[] = [
  {
    mediaId: 1,
    videoResolution: "1080",
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
    fileSize: 1_000,
  },
  {
    mediaId: 2,
    videoResolution: "4k",
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
    fileSize: 2_000,
  },
];

function preview(
  overrides: Partial<VersionDeletionPreviewResponse>,
): VersionDeletionPreviewResponse {
  return {
    mediaType: "movie",
    arrService: "radarr",
    versions: [],
    arrConfigured: false,
    arrStatus: "unavailable",
    arrTargets: [],
    arrSelectionMatched: false,
    cleanupConfigured: false,
    cleanupStatus: "unavailable",
    downloadJobs: [],
    orphanFiles: [],
    retainedPaths: [],
    ...overrides,
  };
}

Deno.test("largest version is retained by default", () => {
  assertEquals([...defaultVersionSelection(versions)], [1]);
});

Deno.test("all movie versions stay in the duplicate flow as whole-item deletion", () => {
  assertEquals(
    versionSelectionSemantics("movie", versions, new Set([1, 2])),
    {
      selectedVersions: versions,
      wouldDeleteAll: true,
      deleteWholeItem: true,
      blocked: false,
    },
  );
  assertEquals(versionDeletionExecutionTarget("movie", true), "whole-item");
});

Deno.test("all episode versions remain blocked", () => {
  assertEquals(
    versionSelectionSemantics("episode", versions, new Set([1, 2])).blocked,
    true,
  );
  assertEquals(versionDeletionExecutionTarget("episode", true), "versions");
});

Deno.test("unconfigured destinations stay hidden", () => {
  assertEquals(versionDestinationState(preview({})), {
    arrVisible: false,
    arrAvailable: false,
    arrDeleteAvailable: false,
    arrSelectedByDefault: false,
    cleanupAvailable: false,
    cleanupVisible: false,
  });
});

Deno.test("configured unavailable Arr stays hidden when it has no safe action", () => {
  assertEquals(
    versionDestinationState(preview({ arrConfigured: true })),
    {
      arrVisible: false,
      arrAvailable: false,
      arrDeleteAvailable: false,
      arrSelectedByDefault: false,
      cleanupAvailable: false,
      cleanupVisible: false,
    },
  );
});

Deno.test("an unsafe Arr match is not exposed as a deletion destination", () => {
  const unsafePreview = preview({
    arrConfigured: true,
    arrSelectionMatched: true,
  });
  assertEquals(
    versionDestinationState(unsafePreview),
    {
      arrVisible: false,
      arrAvailable: false,
      arrDeleteAvailable: false,
      arrSelectedByDefault: false,
      cleanupAvailable: false,
      cleanupVisible: false,
    },
  );
  assertEquals(
    versionDeletionPresentation(unsafePreview, true, false).services,
    ["plex"],
  );
  assertEquals(
    versionArrDeletionActive(true, unsafePreview.arrStatus),
    false,
  );
  assertEquals(versionPlexFallbackRequired(unsafePreview), true);
});

Deno.test("an unmanaged Plex copy needs no Arr fallback acknowledgement", () => {
  assertEquals(
    versionPlexFallbackRequired(preview({ arrConfigured: true })),
    false,
  );
});

Deno.test("advanced keeps Plex paths alongside selected deletion services", () => {
  const selected = versionDeletionPresentation(
    preview({
      arrConfigured: true,
      arrStatus: "resolved",
      arrTargets: [{
        instanceName: "Radarr",
        type: "radarr",
        title: "Movie",
        path: "/movies/Movie",
        seasons: null,
        mediaFiles: [],
        extraFiles: [],
      }],
      cleanupConfigured: true,
      cleanupStatus: "resolved",
      orphanFiles: [{
        path: "/downloads/Movie.mkv",
        size: 1_000,
        method: "hardlink",
      }],
    }),
    true,
    true,
  );
  assertEquals(selected.services, ["plex", "radarr"]);
  assertEquals(selected.arrTargets.length, 1);
  assertEquals(selected.orphanFiles.length, 1);
  assertEquals(selected.showPlexPaths, true);
});

Deno.test("cleanup cannot appear unless its destination is configured", () => {
  assertEquals(
    versionDestinationState(preview({ cleanupStatus: "resolved" }))
      .cleanupVisible,
    false,
  );
});

Deno.test("verified cleanup makes the qBittorrent destination visible", () => {
  assertEquals(
    versionDestinationState(preview({
      arrConfigured: true,
      arrStatus: "resolved",
      cleanupConfigured: true,
      cleanupStatus: "resolved",
    })).cleanupVisible,
    true,
  );
});

Deno.test("no-path previews terminate as Plex-only presentation", () => {
  const selected = versionDeletionPresentation(
    preview({
      arrConfigured: true,
      versions: [{
        mediaId: 1,
        plexPaths: [],
        arrPaths: [],
        cleanupPaths: [],
        status: "unavailable",
        reason: "Plex did not report a path",
        truncated: false,
      }],
    }),
    true,
    false,
  );
  assertEquals(selected.services, ["plex"]);
  assertEquals(selected.showPlexPaths, true);
  assertEquals(selected.arrTargets, []);
});
