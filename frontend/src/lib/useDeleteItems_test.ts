import { assertEquals } from "@std/assert";
import { partitionDeletionRatingKeys } from "./deletionPlan.ts";

Deno.test("mixed deletion selections partition verified Arr items from Plex-only fallbacks", () => {
  assertEquals(
    partitionDeletionRatingKeys(
      ["plex-1", "arr-1", "arr-2", "plex-2", "arr-1"],
      ["arr-2", "outside-selection", "arr-1", "arr-1"],
    ),
    {
      coordinated: ["arr-2", "arr-1"],
      plexOnly: ["plex-1", "plex-2"],
    },
  );
});
