import { currentLocationOwnershipProblem } from "./deletionPreviewState.ts";
import type { DownloadCleanupPreviewItem } from "../../../../shared/types.ts";
import { assertEquals } from "@std/assert";
import type { DownloadCleanupPreviewResponse } from "../../../../shared/types.ts";
import {
  arrDestinationState,
  cleanupConsentInvalidated,
  downloadCleanupDestinationVisible,
  effectiveArrSelection,
  eligibleDownloadCleanupItems,
  selectedSonarrOwnershipProblems,
  shouldDefaultOrphanOnlyCleanup,
  shouldUseArrByDefault,
  SONARR_OWNED_PATH_COPY,
} from "./deletionPreviewState.ts";

Deno.test("Sonarr destinations describe current managed files", () => {
  assertEquals(
    SONARR_OWNED_PATH_COPY,
    "Applies the shown Sonarr change to current managed files. Identified qBittorrent files are retained unless qBittorrent is also selected.",
  );
});

Deno.test("selected whole-show Sonarr ownership errors block with their exact reason", () => {
  const unsafe = {
    items: [{ sonarrCleanupStatus: "error", sonarrCleanupReason: "managed entry is owned" }],
  } as never;
  assertEquals(
    selectedSonarrOwnershipProblems(unsafe, true).map((item) => item.sonarrCleanupReason),
    [
      "managed entry is owned",
    ],
  );
  assertEquals(selectedSonarrOwnershipProblems(unsafe, false), []);
});

Deno.test("configured Arr remains visible when every selected item is unavailable", () => {
  const preview = {
    coordinatedConfigured: true,
    downloadClientsConfigured: false,
    items: [{ ratingKey: "1", arrStatus: "unavailable" }],
  } as DownloadCleanupPreviewResponse;

  const state = arrDestinationState(preview);

  assertEquals(state.visible, true);
  assertEquals(state.problems, preview.items);
});

Deno.test("configured Arr never grants default deletion consent", () => {
  const preview = {
    coordinatedConfigured: true,
    downloadClientsConfigured: false,
    items: [{ ratingKey: "1", arrStatus: "unavailable" }],
  } as DownloadCleanupPreviewResponse;

  assertEquals(shouldUseArrByDefault(preview), false);
  assertEquals(shouldUseArrByDefault(undefined), false);
  assertEquals(effectiveArrSelection(false, preview), false);
  assertEquals(effectiveArrSelection(true, preview), true);
});

Deno.test("Arr is disabled by default only when no destination is configured", () => {
  const preview = {
    coordinatedConfigured: false,
    downloadClientsConfigured: false,
    items: [],
  } as DownloadCleanupPreviewResponse;

  assertEquals(shouldUseArrByDefault(preview), false);
});

Deno.test("stale Arr selection is suppressed as soon as an unconfigured preview arrives", () => {
  const preview = {
    coordinatedConfigured: false,
    downloadClientsConfigured: false,
    items: [],
  } as DownloadCleanupPreviewResponse;

  assertEquals(effectiveArrSelection(true, undefined), true);
  assertEquals(effectiveArrSelection(true, preview), false);
});

Deno.test("configured download destination stays visible while eligibility is checked", () => {
  const item = {
    ratingKey: "1",
    status: "resolved",
    downloadJobs: [{}],
  };
  assertEquals(
    downloadCleanupDestinationVisible({
      coordinatedConfigured: false,
      downloadClientsConfigured: false,
      items: [item],
    } as unknown as DownloadCleanupPreviewResponse),
    false,
  );
  assertEquals(
    downloadCleanupDestinationVisible({
      coordinatedConfigured: false,
      downloadClientsConfigured: true,
      items: [{ ...item, downloadJobs: [] }],
    } as unknown as DownloadCleanupPreviewResponse),
    true,
  );
  assertEquals(
    downloadCleanupDestinationVisible({
      coordinatedConfigured: false,
      downloadClientsConfigured: true,
      items: [item],
    } as unknown as DownloadCleanupPreviewResponse),
    true,
  );
  assertEquals(
    downloadCleanupDestinationVisible({
      coordinatedConfigured: true,
      downloadClientsConfigured: false,
      items: [{ ...item, downloadJobs: [], orphanFiles: [{}] }],
    } as unknown as DownloadCleanupPreviewResponse, true),
    false,
  );
  assertEquals(
    downloadCleanupDestinationVisible({
      coordinatedConfigured: true,
      downloadClientsConfigured: false,
      items: [{ ...item, downloadJobs: [], orphanFiles: [{}] }],
    } as unknown as DownloadCleanupPreviewResponse, false),
    false,
  );
});

Deno.test("historical cleanup never defaults into a current-location request", () => {
  const orphan = {
    ratingKey: "show-1",
    status: "resolved",
    downloadJobs: [],
    orphanFiles: [{}],
  };
  assertEquals(
    shouldDefaultOrphanOnlyCleanup({
      coordinatedConfigured: true,
      downloadClientsConfigured: false,
      items: [orphan],
    } as unknown as DownloadCleanupPreviewResponse),
    false,
  );
  assertEquals(
    shouldDefaultOrphanOnlyCleanup({
      coordinatedConfigured: true,
      downloadClientsConfigured: true,
      items: [orphan, { ...orphan, ratingKey: "show-2", downloadJobs: [{}] }],
    } as unknown as DownloadCleanupPreviewResponse),
    false,
  );
});

Deno.test("an unresolved current QB job exposes access resolution without authorizing cleanup", () => {
  const value = {
    coordinatedConfigured: false,
    downloadClientsConfigured: true,
    items: [{
      ratingKey: "show",
      status: "unavailable",
      downloadJobs: [],
      qbittorrentPathAccessJob: { jobId: "live-job" },
    }],
  } as unknown as DownloadCleanupPreviewResponse;
  assertEquals(downloadCleanupDestinationVisible(value), true);
  assertEquals(eligibleDownloadCleanupItems(value, false, false), []);
});

Deno.test("bulk cleanup selects current jobs and excludes historical files", () => {
  const preview = {
    coordinatedConfigured: true,
    downloadClientsConfigured: true,
    items: [
      { ratingKey: "orphan", status: "resolved", downloadJobs: [], orphanFiles: [{}] },
      { ratingKey: "live", status: "resolved", downloadJobs: [{}], orphanFiles: [] },
      { ratingKey: "unavailable", status: "unavailable", downloadJobs: [], orphanFiles: [{}] },
    ],
  } as unknown as DownloadCleanupPreviewResponse;

  assertEquals(
    eligibleDownloadCleanupItems(preview, true, true).map((item) => item.ratingKey),
    ["live"],
  );
  assertEquals(
    eligibleDownloadCleanupItems(preview, true, false).map((item) => item.ratingKey),
    ["live"],
  );
});

Deno.test("cleanup consent is invalidated only when selected evidence changes", () => {
  assertEquals(cleanupConsentInvalidated(true, "same", "same"), false);
  assertEquals(cleanupConsentInvalidated(true, "changed", "accepted"), true);
  assertEquals(cleanupConsentInvalidated(true, null, "accepted"), true);
  assertEquals(cleanupConsentInvalidated(false, "changed", "accepted"), false);
});

Deno.test("current destination ownership ignores unchecked Sonarr but preserves Plex and QB blockers", () => {
  const item = {
    status: "resolved",
    sonarrCleanupStatus: "error",
    sonarrCleanupReason: "Sonarr mapping needed",
    plexOnlyStatus: "resolved",
    qbittorrentOnlyStatus: "resolved",
  } as DownloadCleanupPreviewItem;
  assertEquals(currentLocationOwnershipProblem(item, true, false).blocked, true);
  assertEquals(currentLocationOwnershipProblem(item, true, true).blocked, false);
  item.status = "error";
  item.reason = "Shared pack contains unselected files";
  assertEquals(currentLocationOwnershipProblem(item, true, true), {
    blocked: true,
    reason: "Shared pack contains unselected files",
  });
  assertEquals(currentLocationOwnershipProblem(item, false, false).blocked, false);
  assertEquals(currentLocationOwnershipProblem(item, false, true).blocked, false);
  item.plexOnlyStatus = "error";
  item.plexOnlyReason = "Plex mapping needed";
  assertEquals(currentLocationOwnershipProblem(item, false, false), {
    blocked: true,
    reason: "Plex mapping needed",
  });
  item.qbittorrentOnlyStatus = "error";
  item.qbittorrentOnlyReason = "Current QB payload unresolved";
  assertEquals(currentLocationOwnershipProblem(item, false, true), {
    blocked: true,
    reason: "Current QB payload unresolved",
  });
});
