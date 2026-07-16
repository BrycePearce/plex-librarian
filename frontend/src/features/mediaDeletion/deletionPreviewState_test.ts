import { assertEquals } from "@std/assert";
import type { DownloadCleanupPreviewResponse } from "../../../../shared/types.ts";
import { arrDestinationState } from "./deletionPreviewState.ts";

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
