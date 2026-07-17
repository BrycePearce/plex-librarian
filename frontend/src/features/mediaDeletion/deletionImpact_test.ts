import { assertEquals } from "@std/assert";
import { deletionImpact } from "./deletionImpact.ts";
import type { WholeItemDeletionCandidate } from "./types.ts";

let nextId = 1;
function item(fileSize: number | null): WholeItemDeletionCandidate {
  return {
    ratingKey: String(nextId++),
    libraryKey: "movies",
    title: "Movie",
    type: "movie",
    fileSize,
  };
}

Deno.test("deletion impact totals known sizes and reports unknown sizes", () => {
  assertEquals(deletionImpact([item(1000), item(2500), item(null)]), {
    totalSize: 3500,
    unknownSizeCount: 1,
  });
});
