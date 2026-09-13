import { assertEquals } from "@std/assert";
import type { DuplicateGroup, MediaVersion } from "../../lib/api.ts";
import { selectedServiceVersions } from "./ServiceVersionPickerDialog.tsx";

Deno.test("service version selection retains exact media IDs and only promotes fully selected movies", () => {
  const versions = [{ mediaId: 1 }, { mediaId: 2 }] as MediaVersion[];
  const movie: DuplicateGroup = {
    mediaType: "movie",
    ratingKey: "movie",
    libraryKey: "lib",
    title: "Movie",
    thumb: null,
    year: null,
    combinedFileSize: 10,
    versions,
  };
  const episode: DuplicateGroup = {
    mediaType: "episode",
    episodeRatingKey: "episode",
    libraryKey: "lib",
    showRatingKey: "show",
    seasonRatingKey: "season",
    showTitle: "Show",
    showThumb: null,
    seasonIndex: 1,
    episodeIndex: 1,
    episodeTitle: "Episode",
    combinedFileSize: 10,
    versions,
  };
  assertEquals(selectedServiceVersions([movie], new Set()), []);
  assertEquals(selectedServiceVersions([{ ...movie, versions: [] }], new Set()), []);
  assertEquals(selectedServiceVersions([movie], new Set(["movie:1"])), [{
    ratingKey: "movie",
    mediaId: 1,
  }]);
  assertEquals(selectedServiceVersions([movie], new Set(["movie:1", "movie:2"])), [{
    ratingKey: "movie",
  }]);
  assertEquals(selectedServiceVersions([episode], new Set(["episode:2"])), [{
    ratingKey: "episode",
    mediaId: 2,
  }]);
});
