import { assertEquals } from "@std/assert";
import {
  episodeCoverageLabel,
  initialIndividualSelectionKeys,
  initialSeasonSelectionKeys,
  MAX_SEASON_CLEANUP_EPISODES,
  refreshExpiredSeasonDeletionPreview,
  seasonDeletionAuthorizationKey,
  seasonDeletionConfirmationDisabled,
  seasonDeletionConflictOperationId,
  seasonDeletionPreviewIsUsable,
  seasonDownloadCleanupVisible,
  seasonProfilesDeletionPlan,
  seasonProfileSelection,
} from "./SeasonDuplicateDialog.tsx";
import { ApiError } from "../../lib/api.ts";
import type { DuplicateEpisodeGroup, MediaVersion, SeasonVersionProfile } from "../../lib/api.ts";

function version(mediaId: number): MediaVersion {
  return {
    mediaId,
    videoResolution: "1080",
    width: 1920,
    height: 1080,
    duration: 1,
    bitrate: 1,
    videoCodec: "h264",
    videoProfile: null,
    videoBitDepth: 8,
    videoDynamicRange: null,
    videoFrameRate: null,
    videoScanType: null,
    container: "mkv",
    audioCodec: "aac",
    audioChannels: 2,
    audioProfile: null,
    audioStreams: [],
    subtitleStreams: [],
    streamDetailsAvailable: true,
    fileSize: 10,
  };
}

function episode(key: string, mediaIds: number[]): DuplicateEpisodeGroup {
  return {
    mediaType: "episode",
    libraryKey: "shows",
    episodeRatingKey: key,
    showRatingKey: "show",
    seasonRatingKey: "season",
    showTitle: "Show",
    showThumb: null,
    seasonIndex: 1,
    episodeIndex: 1,
    episodeTitle: key,
    combinedFileSize: 30,
    versions: mediaIds.map(version),
  };
}

function profile(id: string, members: SeasonVersionProfile["members"]): SeasonVersionProfile {
  return {
    id,
    label: id,
    coverageCount: members.length,
    technicalVariantCount: 1,
    totalFileSize: members.length * 10,
    bitrateSummary: "1.0 Mbps",
    videoSummary: "1080p",
    audioSummary: [],
    subtitleSummary: [],
    sourceHints: [],
    members,
  };
}

Deno.test("episode coverage compacts sequential and isolated episode indexes", () => {
  assertEquals(episodeCoverageLabel([20, 2, 1, 13, 14, 15, 2]), {
    compact: "E1–E2, E13–E15, E20",
    full: "E1–E2, E13–E15, E20",
    truncated: false,
  });
});

Deno.test("episode coverage abbreviates fragmented lanes without hiding the full list", () => {
  assertEquals(episodeCoverageLabel([1, 3, 5, 7, 9, 11]), {
    compact: "E1, E3, E5, +3 more",
    full: "E1, E3, E5, E7, E9, E11",
    truncated: true,
  });
});

Deno.test("oversized season review stays within the durable cleanup group limit", () => {
  const keys = Array.from(
    { length: MAX_SEASON_CLEANUP_EPISODES + 25 },
    (_, index) => `episode-${index}`,
  );
  const selected = initialSeasonSelectionKeys(keys);

  assertEquals(selected.size, MAX_SEASON_CLEANUP_EPISODES);
  assertEquals([...selected].at(-1), `episode-${MAX_SEASON_CLEANUP_EPISODES - 1}`);
});

Deno.test("multiple season lanes union explicit deletion ids by episode", () => {
  const profiles = [
    profile("low", [
      { episodeRatingKey: "episode-1", mediaId: 11 },
      { episodeRatingKey: "episode-2", mediaId: 21 },
    ]),
    profile("medium", [
      { episodeRatingKey: "episode-1", mediaId: 12 },
      { episodeRatingKey: "episode-2", mediaId: 22 },
    ]),
  ];
  const plan = seasonProfilesDeletionPlan(
    profiles,
    new Set(["low", "medium"]),
    [episode("episode-1", [11, 12, 13]), episode("episode-2", [21, 22, 23])],
  );
  assertEquals(plan.safe, true);
  assertEquals([...plan.deleteMediaIds], [
    ["episode-1", [11, 12]],
    ["episode-2", [21, 22]],
  ]);
});

Deno.test("season lane combinations fail closed before deleting every episode version", () => {
  const profiles = [
    profile("low", [{ episodeRatingKey: "episode-1", mediaId: 11 }]),
    profile("high", [{ episodeRatingKey: "episode-1", mediaId: 12 }]),
  ];
  const plan = seasonProfilesDeletionPlan(
    profiles,
    new Set(["low", "high"]),
    [episode("episode-1", [11, 12])],
  );
  assertEquals(plan.safe, false);
});

Deno.test("individual season review starts fail-closed", () => {
  assertEquals([...initialIndividualSelectionKeys()], []);
});

Deno.test("individual season review requires the same authoritative destructive preview", () => {
  const base = {
    pending: false,
    selectionCount: 1,
    mode: "episodes" as const,
    profileReady: true,
    previewLoading: false,
    previewError: false,
    previewAvailable: true,
    blockerCount: 0,
  };
  assertEquals(seasonDeletionConfirmationDisabled(base), false);
  assertEquals(
    seasonDeletionConfirmationDisabled({ ...base, previewAvailable: false }),
    true,
  );
});

Deno.test("season deletion conflicts expose their existing operation", () => {
  assertEquals(
    seasonDeletionConflictOperationId(
      new ApiError(409, "conflict", {
        code: "DELETION_CONFLICT",
        operationId: "operation-1",
      }),
    ),
    "operation-1",
  );
  assertEquals(
    seasonDeletionConflictOperationId(
      new ApiError(409, "request conflict", {
        code: "REQUEST_ID_CONFLICT",
        operationId: "operation-1",
      }),
    ),
    null,
  );
});

Deno.test("season deletion previews require enough validity to survive submission", () => {
  assertEquals(seasonDeletionPreviewIsUsable(1_006, 1_000), true);
  assertEquals(seasonDeletionPreviewIsUsable(1_005, 1_000), false);
  assertEquals(seasonDeletionPreviewIsUsable(999, 1_000), false);
});

Deno.test("expired season deletion previews refresh before authorization is submitted", async () => {
  let refreshCount = 0;
  const fresh = { fingerprint: "fresh", expiresAt: Math.floor(Date.now() / 1000) + 300 };
  const result = await refreshExpiredSeasonDeletionPreview(
    { fingerprint: "expired", expiresAt: 1 },
    () => {
      refreshCount++;
      return Promise.resolve({ data: fresh });
    },
    1_000,
  );

  assertEquals(refreshCount, 1);
  assertEquals(result, fresh);
});

Deno.test("fresh season deletion previews submit without another authoritative read", async () => {
  let refreshCount = 0;
  const fresh = { fingerprint: "fresh", expiresAt: 1_300 };
  const result = await refreshExpiredSeasonDeletionPreview(
    fresh,
    () => {
      refreshCount++;
      return Promise.resolve({ data: undefined });
    },
    1_000,
  );

  assertEquals(refreshCount, 0);
  assertEquals(result, fresh);
});

Deno.test("destructive destination authorization is bound to the exact media selection", () => {
  const original = seasonDeletionAuthorizationKey([
    { ratingKey: "episode-2", deleteMediaIds: [22, 21] },
    { ratingKey: "episode-1", deleteMediaIds: [11] },
  ]);
  assertEquals(
    original,
    seasonDeletionAuthorizationKey([
      { ratingKey: "episode-1", deleteMediaIds: [11] },
      { ratingKey: "episode-2", deleteMediaIds: [21, 22] },
    ]),
  );
  assertEquals(
    original === seasonDeletionAuthorizationKey([
      { ratingKey: "episode-1", deleteMediaIds: [12] },
      { ratingKey: "episode-2", deleteMediaIds: [21, 22] },
    ]),
    false,
  );
});

Deno.test("season download cleanup is offered only for verified selected versions", () => {
  assertEquals(seasonDownloadCleanupVisible(false, { cleanupEligibleVersionCount: 2 }), false);
  assertEquals(seasonDownloadCleanupVisible(true, { cleanupEligibleVersionCount: 0 }), false);
  assertEquals(seasonDownloadCleanupVisible(true, { cleanupEligibleVersionCount: 2 }), true);
});

Deno.test("season profile selection expands only explicit members into deletion ids", () => {
  const profile: SeasonVersionProfile = {
    id: "profile-a",
    label: "English",
    coverageCount: 2,
    technicalVariantCount: 1,
    totalFileSize: 30,
    bitrateSummary: "5.0 Mbps",
    videoSummary: "1080p",
    audioSummary: ["eng"],
    subtitleSummary: [],
    sourceHints: [],
    members: [
      { episodeRatingKey: "episode-1", mediaId: 11 },
      { episodeRatingKey: "episode-2", mediaId: 21 },
      { episodeRatingKey: "outside-pass", mediaId: 31 },
    ],
  };
  const selection = seasonProfileSelection(profile, ["episode-1", "episode-2", "exception"]);
  assertEquals([...selection.selected], ["episode-1", "episode-2"]);
  assertEquals([...selection.deleteMediaIds], [["episode-1", [11]], ["episode-2", [21]]]);
});
