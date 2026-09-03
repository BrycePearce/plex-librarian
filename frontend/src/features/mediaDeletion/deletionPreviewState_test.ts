import { assertEquals } from "@std/assert";
import type { DownloadCleanupPreviewResponse } from "../../../../shared/types.ts";
import {
  arrDestinationState,
  cleanupConsentInvalidated,
  downloadCleanupDestinationVisible,
  effectiveArrSelection,
  eligibleDownloadCleanupItems,
  shouldDefaultOrphanOnlyCleanup,
  shouldUseArrByDefault,
} from "./deletionPreviewState.ts";

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

Deno.test("configured Arr stays selected when no selected item resolves", () => {
  const preview = {
    coordinatedConfigured: true,
    downloadClientsConfigured: false,
    items: [{ ratingKey: "1", arrStatus: "unavailable" }],
  } as DownloadCleanupPreviewResponse;

  assertEquals(shouldUseArrByDefault(preview), true);
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

Deno.test("download cleanup is visible for a verified job or an orphan-only proof", () => {
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
    false,
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
    true,
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

Deno.test("verified orphan-only cleanup defaults on without opting into live job deletion", () => {
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
    true,
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

Deno.test("bulk cleanup selects exact eligible shows and binds orphans to Sonarr", () => {
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
    ["orphan", "live"],
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
