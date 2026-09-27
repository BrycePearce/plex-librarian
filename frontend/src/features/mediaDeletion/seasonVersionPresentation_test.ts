import { assertEquals } from "@std/assert";
import {
  episodeCoverageLabel,
  groupSeasonLanePaths,
  seasonLaneMatchBasisLabel,
} from "./seasonVersionPresentation.ts";
Deno.test("season lane match basis uses explicit evidence explanations", () => {
  assertEquals(seasonLaneMatchBasisLabel("release-root"), "Folder matched");
  assertEquals(seasonLaneMatchBasisLabel("technical-only"), "Technical match");
  assertEquals(seasonLaneMatchBasisLabel("mixed"), "Mixed evidence");
  assertEquals(seasonLaneMatchBasisLabel("filename-family"), "Filename matched");
});

Deno.test("lane paths group by normalized directory and sort by episode", () => {
  assertEquals(
    groupSeasonLanePaths([
      { episodeRatingKey: "episode-2", episodeIndex: 2, filePath: "D:\\TV\\Show\\S01E02.mkv" },
      { episodeRatingKey: "episode-1", episodeIndex: 1, filePath: "D:\\TV\\Show\\S01E01.mkv" },
      { episodeRatingKey: "episode-3", episodeIndex: 3, filePath: null },
    ]),
    [{
      directory: "D:\\TV\\Show",
      files: [
        {
          episodeRatingKey: "episode-1",
          episodeIndex: 1,
          filePath: "D:\\TV\\Show\\S01E01.mkv",
          filename: "S01E01.mkv",
        },
        {
          episodeRatingKey: "episode-2",
          episodeIndex: 2,
          filePath: "D:\\TV\\Show\\S01E02.mkv",
          filename: "S01E02.mkv",
        },
      ],
    }],
  );
});

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
