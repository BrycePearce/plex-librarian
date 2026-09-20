import { assertEquals } from "@std/assert";
import type { MediaVersion, SmartDuplicateEpisodeCandidate } from "../../lib/api.ts";
import { candidateKey, selectedSize, serviceCleanupBatches } from "./model.ts";

function version(mediaId: number, fileSize: number): MediaVersion {
  return {
    mediaId,
    videoResolution: null,
    width: null,
    height: null,
    duration: null,
    bitrate: null,
    videoCodec: null,
    videoProfile: null,
    videoBitDepth: null,
    videoDynamicRange: null,
    videoFrameRate: null,
    videoScanType: null,
    container: null,
    audioCodec: null,
    audioChannels: null,
    audioProfile: null,
    audioStreams: [],
    subtitleStreams: [],
    streamDetailsAvailable: false,
    fileSize,
  };
}

function episode(ratingKey: string, mediaBase: number): SmartDuplicateEpisodeCandidate {
  return {
    mediaType: "episode",
    libraryKey: "shows",
    ratingKey,
    title: "Show",
    context: null,
    confidence: "obvious",
    keepMediaId: mediaBase + 1,
    deleteMediaIds: [mediaBase],
    reclaimableSize: 10,
    reasons: [],
    versions: [version(mediaBase, 10), version(mediaBase + 1, 20)],
    showRatingKey: "show",
    seasonRatingKey: "season",
    seasonIndex: 1,
    episodeIndex: mediaBase,
    episodeTitle: `Episode ${mediaBase}`,
  };
}

Deno.test("season savings only includes selected Quick Cleanup episodes", () => {
  const first = episode("episode-1", 10);
  const second = episode("episode-2", 20);

  assertEquals(
    selectedSize([first, second], new Set([candidateKey(first)]), new Map()),
    10,
  );
  assertEquals(selectedSize([first, second], new Set(), new Map()), 0);
});

Deno.test("service cleanup batches separate libraries and keep each title together", () => {
  const plans = Array.from({ length: 21 }, (_, index) => ({
    candidate: { libraryKey: "movies", ratingKey: String(index) },
    deleteMediaIds: Array.from({ length: 10 }, (_, media) => index * 10 + media + 1),
  }));
  const batches = serviceCleanupBatches([...plans, {
    candidate: { libraryKey: "shows", ratingKey: "episode" },
    deleteMediaIds: [501],
  }]);
  assertEquals(batches.map((batch) => [batch.libraryKey, batch.targets.length]), [["movies", 200], [
    "movies",
    10,
  ], ["shows", 1]]);
  assertEquals(batches[1].targets.map((target) => target.ratingKey), Array(10).fill("20"));
  assertEquals(serviceCleanupBatches([]), []);
});
