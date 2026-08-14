import { assertEquals } from "@std/assert";
import type { MediaVersion, SmartDuplicateEpisodeCandidate } from "../../lib/api.ts";
import { candidateKey, selectedSize } from "./model.ts";

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
