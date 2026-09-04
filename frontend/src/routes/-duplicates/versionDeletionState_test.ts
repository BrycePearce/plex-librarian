import { assertEquals } from "@std/assert";
import type { MediaVersion, VersionDeletionPreviewResponse } from "../../lib/api.ts";
import {
  defaultVersionSelection,
  versionArrDeletionActive,
  versionArrDestinationCopy,
  versionCleanupReassignmentLocked,
  versionDeletionExecutionTarget,
  versionDeletionPresentation,
  versionDestinationOptionVisibility,
  versionDestinationState,
  versionPathPreviewsByMediaId,
  versionPlexFallbackWarning,
  versionRadarrPathOverride,
  versionSelectionSemantics,
  versionSonarrOwnershipBlocked,
} from "./versionDeletionState.ts";
import { sonarrRetainedPathsSummary } from "../../features/mediaDeletion/SonarrRetainedPathsWarning.tsx";

Deno.test("Sonarr reassignment does not lock independent qBittorrent selection", () => {
  assertEquals(versionCleanupReassignmentLocked("episode", true, false), false);
  assertEquals(versionCleanupReassignmentLocked("movie", true, false), true);
  assertEquals(versionCleanupReassignmentLocked("movie", false, true), true);
});

Deno.test("unsafe episode Sonarr ownership blocks only while Sonarr is selected", () => {
  const preview = {
    mediaType: "episode",
    sonarrCleanupStatus: "error",
    sonarrCleanupReason: "managed entry is owned",
  } as VersionDeletionPreviewResponse;
  assertEquals(versionSonarrOwnershipBlocked(preview, true), true);
  assertEquals(versionSonarrOwnershipBlocked(preview, false), false);
});

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

Deno.test("Sonarr implies its automatic historical unlink without selecting qBittorrent", () => {
  const selected = versionDeletionPresentation(
    preview({
      arrService: "sonarr",
      arrConfigured: true,
      arrStatus: "resolved",
      arrTargets: [{
        instanceName: "Sonarr",
        type: "sonarr",
        title: "Show",
        path: "/tv/Show",
        seasons: [],
        mediaFiles: [],
        extraFiles: [],
      }],
      cleanupStatus: "resolved",
      orphanFiles: [{ path: "/downloads/episode.mkv", size: 1_000, method: "hardlink" }],
    }),
    true,
    false,
  );
  assertEquals(selected.orphanFiles.length, 1);
  assertEquals(selected.downloadJobs.length, 0);
});

Deno.test("Sonarr preview switches historical ownership only with qBittorrent selection", () => {
  const value = preview({
    arrService: "sonarr",
    arrConfigured: true,
    arrStatus: "resolved",
    cleanupStatus: "resolved",
    downloadJobs: [{
      provider: "qbittorrent",
      instanceKey: "qb:1",
      instanceName: "qBittorrent",
      jobId: "a".repeat(40),
      name: "release",
      state: "uploading",
      size: 1_000,
      uploaded: 0,
      ratio: null,
      seedingTime: 0,
      completedAt: null,
      contentPath: "/downloads/episode.mkv",
      savePath: "/downloads",
      trackerHost: null,
      fileCount: 1,
      files: [{ path: "episode.mkv", size: 1_000 }],
      filesTruncated: false,
      sourcePath: "/downloads/episode.mkv",
    }],
    orphanFiles: [],
    sonarrHistoricalPaths: [{
      path: "/downloads/episode.mkv",
      managedPath: "/library/episode.mkv",
      size: 1_000,
      disposition: "retain_live_qbittorrent",
      reason: "live owner",
    }],
    qbittorrentOrphanFiles: [{
      path: "/downloads/episode.mkv",
      size: 1_000,
      method: "hardlink",
    }],
    qbittorrentSonarrHistoricalPaths: [{
      path: "/downloads/episode.mkv",
      managedPath: "/library/episode.mkv",
      size: 1_000,
      disposition: "delete",
      reason: "selected owner",
    }],
  });
  const sonarrOnly = versionDeletionPresentation(value, true, false);
  assertEquals(sonarrOnly.orphanFiles, []);
  assertEquals(sonarrOnly.sonarrHistoricalPaths[0]?.disposition, "retain_live_qbittorrent");
  assertEquals(sonarrRetainedPathsSummary(sonarrOnly.sonarrHistoricalPaths)?.count, 1);

  const coordinated = versionDeletionPresentation(value, true, true);
  assertEquals(coordinated.orphanFiles.length, 0);
  assertEquals(coordinated.sonarrHistoricalPaths[0]?.disposition, "delete");
  assertEquals(coordinated.sonarrHistoricalPaths[0]?.reason, "selected owner");
  assertEquals(sonarrRetainedPathsSummary(coordinated.sonarrHistoricalPaths), null);
  assertEquals(coordinated.downloadJobs.length, 1);
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

Deno.test("Radarr removal fallback names and explains its exact action", () => {
  const removal = preview({
    arrConfigured: true,
    radarrPathAdoption: {
      mode: "remove_from_radarr",
      requiresConsent: true,
    } as VersionDeletionPreviewResponse["radarrPathAdoption"],
  });
  assertEquals(versionArrDestinationCopy(removal, "Radarr", true), {
    label: "Remove movie from Radarr",
    info:
      "Radarr cannot safely adopt any remaining Plex version. Plex Librarian will unmonitor the movie, create an import exclusion, and remove its Radarr record without asking Radarr to delete files. Plex then deletes the selected version.",
  });
  assertEquals(versionArrDestinationCopy(removal, "Radarr", true, true, false), {
    label: "Remove movie from Radarr",
    info:
      "Radarr will not be changed. Plex will delete the selected file directly, and Radarr may download it again if the title remains monitored.",
  });
});

Deno.test("Arr destination labels and explanations match their strategy", () => {
  assertEquals(versionArrDestinationCopy(preview({}), "Radarr", false), {
    label: "Remove from Radarr",
    info: "Removes only the Radarr record whose managed paths match the selected Plex versions.",
  });
  assertEquals(versionArrDestinationCopy(preview({}), "Sonarr", true, false), {
    label: "Switch Sonarr to remaining version",
    info:
      "Required to keep the record: Sonarr currently manages the selected file. Before Plex deletes it, Plex Librarian will make Sonarr adopt the remaining version and preserve the existing monitoring state. Applies the shown Sonarr change and removes its verified historical import links. Active qBittorrent payloads are retained unless qBittorrent is also selected.",
  });
  assertEquals(versionArrDestinationCopy(preview({}), "Radarr", true, true, false), {
    label: "Switch Radarr to remaining version",
    info:
      "Radarr will not be changed. Plex will delete the selected file directly, and Radarr may download it again if the title remains monitored.",
  });
  assertEquals(versionArrDestinationCopy(preview({}), "Radarr", true, true, true, 4), {
    label: "Switch Radarr to best remaining version",
    info:
      "Radarr currently manages the selected file. Before Plex deletes it, Plex Librarian will make Radarr adopt the best remaining version and preserve the existing monitoring state. Radarr switches to only the highest-ranked eligible survivor; other remaining Plex versions stay unchanged.",
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
