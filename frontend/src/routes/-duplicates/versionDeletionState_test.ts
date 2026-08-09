import { assertEquals } from "@std/assert";
import type { MediaVersion, VersionDeletionPreviewResponse } from "../../lib/api.ts";
import {
  defaultVersionSelection,
  versionArrDeletionActive,
  versionArrDestinationCopy,
  versionDeletionExecutionTarget,
  versionDeletionPresentation,
  versionDestinationOptionVisibility,
  versionDestinationState,
  versionPathPreviewsByMediaId,
  versionPlexFallbackWarning,
  versionRadarrPathOverride,
  versionSelectionSemantics,
} from "./versionDeletionState.ts";

Deno.test("selected unavailable version preserves its precise Plex reason", () => {
  const previews = versionPathPreviewsByMediaId(
    [{
      mediaId: 2,
      plexPaths: ["/movies/live.mkv"],
      arrPaths: [],
      cleanupPaths: [],
      status: "resolved",
      truncated: false,
    }],
    [{
      mediaId: 1,
      plexPaths: [],
      arrPaths: [],
      cleanupPaths: [],
      status: "unavailable",
      reason: "This Media version is no longer reported by Plex",
      truncated: false,
    }],
  );

  assertEquals(previews.get(1)?.reason, "This Media version is no longer reported by Plex");
  assertEquals(previews.get(2)?.plexPaths, ["/movies/live.mkv"]);
});

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
    availableVersions: [],
    versions: [],
    arrConfigured: false,
    arrStatus: "unavailable",
    arrTargets: [],
    arrSelectionMatched: false,
    arrReassignStatus: "unavailable",
    radarrPathAdoption: { mode: "unavailable", requiresConsent: false },
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
  assertEquals(versionSelectionSemantics("movie", versions, new Set([1, 2])), {
    selectedVersions: versions,
    wouldDeleteAll: true,
    deleteWholeItem: true,
    blocked: false,
  });
  assertEquals(versionDeletionExecutionTarget("movie", true), "whole-item");
});

Deno.test("all episode versions remain blocked", () => {
  assertEquals(versionSelectionSemantics("episode", versions, new Set([1, 2])).blocked, true);
  assertEquals(versionDeletionExecutionTarget("episode", true), "versions");
});

Deno.test("unconfigured destinations stay hidden", () => {
  assertEquals(versionDestinationState(preview({})), {
    arrVisible: false,
    arrAvailable: false,
    arrDeleteAvailable: false,
    arrReassignAvailable: false,
    arrSelectedByDefault: false,
    cleanupAvailable: false,
    cleanupVisible: false,
  });
});

Deno.test("configured unavailable Arr stays hidden when it has no safe action", () => {
  assertEquals(versionDestinationState(preview({ arrConfigured: true })), {
    arrVisible: false,
    arrAvailable: false,
    arrDeleteAvailable: false,
    arrReassignAvailable: false,
    arrSelectedByDefault: false,
    cleanupAvailable: false,
    cleanupVisible: false,
  });
});

Deno.test("safe reassignment exposes Arr even when whole-record deletion is unsafe", () => {
  const reassignment = preview({
    arrConfigured: true,
    arrReassignStatus: "resolved",
  });
  assertEquals(versionDestinationState(reassignment), {
    arrVisible: true,
    arrAvailable: true,
    arrDeleteAvailable: false,
    arrReassignAvailable: true,
    arrSelectedByDefault: true,
    cleanupAvailable: false,
    cleanupVisible: false,
  });
  assertEquals(versionPlexFallbackWarning(reassignment), false);
  assertEquals(versionDestinationOptionVisibility(reassignment), {
    arr: true,
    cleanup: false,
  });
});

Deno.test("configured cleanup stays hidden without a verified qBittorrent job", () => {
  assertEquals(
    versionDestinationOptionVisibility(
      preview({
        arrConfigured: true,
        arrStatus: "resolved",
        arrReassignStatus: "resolved",
        cleanupConfigured: true,
        cleanupStatus: "resolved",
        downloadJobs: [],
      }),
    ),
    { arr: true, cleanup: false },
  );
});

Deno.test("an unsafe Arr match is not exposed as a deletion destination", () => {
  const unsafePreview = preview({
    arrConfigured: true,
    arrSelectionMatched: true,
  });
  assertEquals(versionDestinationState(unsafePreview), {
    arrVisible: false,
    arrAvailable: false,
    arrDeleteAvailable: false,
    arrReassignAvailable: false,
    arrSelectedByDefault: false,
    cleanupAvailable: false,
    cleanupVisible: false,
  });
  assertEquals(versionDeletionPresentation(unsafePreview, true, false).services, ["plex"]);
  assertEquals(versionArrDeletionActive(true, unsafePreview.arrStatus), false);
  assertEquals(versionPlexFallbackWarning(unsafePreview), true);
});

Deno.test("an unmanaged Plex copy needs no Arr fallback warning", () => {
  assertEquals(versionPlexFallbackWarning(preview({ arrConfigured: true })), false);
});

Deno.test("advanced keeps Plex paths alongside selected deletion services", () => {
  const selected = versionDeletionPresentation(
    preview({
      arrConfigured: true,
      arrStatus: "resolved",
      arrTargets: [
        {
          instanceName: "Radarr",
          type: "radarr",
          title: "Movie",
          path: "/movies/Movie",
          seasons: null,
          mediaFiles: [],
          extraFiles: [],
        },
      ],
      cleanupConfigured: true,
      cleanupStatus: "resolved",
      orphanFiles: [
        {
          path: "/downloads/Movie.mkv",
          size: 1_000,
          method: "hardlink",
        },
      ],
    }),
    true,
    true,
  );
  assertEquals(selected.services, ["plex", "radarr"]);
  assertEquals(selected.arrTargets.length, 1);
  assertEquals(selected.orphanFiles.length, 1);
  assertEquals(selected.showPlexPaths, true);
});

Deno.test("cleanup cannot appear without a verified qBittorrent job", () => {
  assertEquals(
    versionDestinationState(preview({ cleanupStatus: "resolved" })).cleanupVisible,
    false,
  );
});

Deno.test("verified qBittorrent cleanup makes its destination visible", () => {
  assertEquals(
    versionDestinationState(
      preview({
        arrConfigured: true,
        arrStatus: "resolved",
        cleanupConfigured: true,
        cleanupStatus: "resolved",
        downloadJobs: [
          {
            provider: "qbittorrent",
            instanceKey: "qbit-1",
            instanceName: "qBittorrent",
            jobId: "job-1",
            name: "Movie",
            state: "uploading",
            uploaded: 0,
            ratio: 0,
            seedingTime: 0,
            completedAt: null,
            contentPath: "/downloads/Movie",
            savePath: "/downloads",
            trackerHost: null,
            fileCount: 1,
            files: [],
            filesTruncated: false,
            sourcePath: "/downloads/Movie",
            size: 1_000,
          },
        ],
      }),
    ).cleanupVisible,
    true,
  );
});

Deno.test("no-path previews terminate as Plex-only presentation", () => {
  const selected = versionDeletionPresentation(
    preview({
      arrConfigured: true,
      versions: [
        {
          mediaId: 1,
          plexPaths: [],
          arrPaths: [],
          cleanupPaths: [],
          status: "unavailable",
          reason: "Plex did not report a path",
          truncated: false,
        },
      ],
    }),
    true,
    false,
  );
  assertEquals(selected.services, ["plex"]);
  assertEquals(selected.showPlexPaths, true);
  assertEquals(selected.arrTargets, []);
});

Deno.test("Radarr destination label stays stable during removal fallback", () => {
  const removal = preview({
    arrConfigured: true,
    radarrPathAdoption: {
      mode: "remove_from_radarr",
      requiresConsent: true,
    } as VersionDeletionPreviewResponse["radarrPathAdoption"],
  });
  assertEquals(versionArrDestinationCopy(removal, "Radarr", true), {
    label: "Radarr",
    info:
      "Required to complete this deletion safely: Radarr will stop managing the movie without being asked to delete any files.",
  });
});

Deno.test("Arr destination labels stay service-based across deletion strategies", () => {
  assertEquals(versionArrDestinationCopy(preview({}), "Radarr", false), {
    label: "Radarr",
    info: "Removes only the Radarr record whose managed paths match the selected Plex versions.",
  });
  assertEquals(versionArrDestinationCopy(preview({}), "Sonarr", true), {
    label: "Sonarr",
    info:
      "Required to keep the Sonarr record: Sonarr will adopt an unselected Plex version before removing its currently managed file.",
  });
});

Deno.test("break-glass Radarr path control appears only for a complete consent plan", () => {
  assertEquals(
    versionRadarrPathOverride(
      preview({
        radarrPathOverride: {
          mode: "adopt_path_with_consent",
          requiresConsent: true,
        },
      }),
    ),
    null,
  );
  const candidate = {
    mode: "adopt_path_with_consent" as const,
    requiresConsent: true,
    planFingerprint: "exact-plan",
    proposedMoviePath: "/downloads/Movie",
    retainedPath: "/downloads/Movie/movie.mkv",
  };
  assertEquals(versionRadarrPathOverride(preview({ radarrPathOverride: candidate })), candidate);
});
