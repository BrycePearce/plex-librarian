import { assertEquals } from "@std/assert";
import type {
  MediaVersion,
  VersionDeletionPreviewResponse,
} from "../../lib/api.ts";
import {
  defaultVersionSelection,
  versionDeletionExecutionTarget,
  versionDeletionPresentation,
  versionDestinationState,
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
    arrSelectedByDefault: false,
    cleanupAvailable: false,
    cleanupVisible: false,
  });
});

Deno.test("configured unavailable Arr follows whole-item warning behavior", () => {
  assertEquals(
    versionDestinationState(preview({ arrConfigured: true })),
    {
      arrVisible: true,
      arrAvailable: false,
      arrSelectedByDefault: true,
      cleanupAvailable: false,
      cleanupVisible: false,
    },
  );
});

Deno.test("basic marks and advanced paths share one destination selection", () => {
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
  assertEquals(selected.showPlexPaths, false);
});

Deno.test("cleanup cannot appear unless its destination is configured", () => {
  assertEquals(
    versionDestinationState(preview({ cleanupStatus: "resolved" }))
      .cleanupVisible,
    false,
  );
});

Deno.test("no-path previews terminate as Plex-only presentation", () => {
  const selected = versionDeletionPresentation(
    preview({
      arrConfigured: true,
      versions: [{
        mediaId: 1,
        plexPaths: [],
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
