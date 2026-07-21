import { assertEquals } from "@std/assert";
import type { DownloadCleanupPreviewResponse } from "../../../../shared/types.ts";
import { arrDestinationState, shouldUseArrByDefault } from "./deletionPreviewState.ts";

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
