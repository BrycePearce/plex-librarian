import { assertEquals, assertNotEquals } from "@std/assert";
import { queryKeys } from "../../../lib/queryKeys.ts";
import { switchEpisodeGapsScope, validateEpisodeGapsSearch } from "./search.ts";

Deno.test("episode gap search defaults malformed scope and normalizes season sorting", () => {
  assertEquals(validateEpisodeGapsSearch({ scope: "broken" }).scope, "episode");
  assertEquals(
    validateEpisodeGapsSearch({ scope: "season", sort: "seasonIndex" }).sort,
    "missingCount",
  );
});

Deno.test("scope switching preserves compatible filters and resets paging and sorting", () => {
  const current = validateEpisodeGapsSearch({
    scope: "episode",
    status: "irregular",
    libraryKey: "tv",
    search: "alpha",
    sort: "seasonIndex",
    order: "asc",
    offset: 100,
  });
  assertEquals(switchEpisodeGapsScope(current, "season"), {
    ...current,
    scope: "season",
    sort: "missingCount",
    order: "desc",
    offset: 0,
  });
});

Deno.test("episode gap query cache keys differ by scope", () => {
  assertNotEquals(
    queryKeys.episodeGaps.list({ scope: "episode" }),
    queryKeys.episodeGaps.list({ scope: "season" }),
  );
});
