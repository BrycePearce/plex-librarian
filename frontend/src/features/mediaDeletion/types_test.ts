import { assertEquals } from "@std/assert";
import type { DuplicateMovieGroup } from "../../lib/api.ts";
import { duplicateMovieDeletionCandidate } from "./types.ts";

Deno.test("duplicate movies preserve every whole-title preview field", () => {
  const group = {
    mediaType: "movie",
    libraryKey: "4k-movies",
    ratingKey: "123",
    title: "Movie",
    year: 2025,
    thumb: null,
    combinedFileSize: 2_000_000,
    versions: [{
      mediaId: 7,
      videoResolution: "4k",
      bitrate: null,
      videoCodec: null,
      container: null,
      fileSize: 2_000_000,
    }],
  } satisfies DuplicateMovieGroup;

  assertEquals(duplicateMovieDeletionCandidate(group), {
    ratingKey: "123",
    libraryKey: "4k-movies",
    title: "Movie",
    type: "movie",
    fileSize: 2_000_000,
    versions: group.versions,
  });
});
