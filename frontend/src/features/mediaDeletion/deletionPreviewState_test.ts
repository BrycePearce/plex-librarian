import { assertEquals } from "@std/assert";
import type { DownloadCleanupPreviewResponse } from "../../../../shared/types.ts";
import {
  arrDestinationState,
  downloadCleanupDestinationVisible,
  effectiveArrSelection,
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
