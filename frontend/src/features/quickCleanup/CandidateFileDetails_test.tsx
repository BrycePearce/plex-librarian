import { assertEquals } from "@std/assert";
import TestRenderer, { act } from "react-test-renderer";
import type { MediaVersion, SmartDuplicateCandidate } from "../../lib/api.ts";
import { CandidateFileDetails } from "./CandidateFileDetails.tsx";

Deno.test("quick cleanup keeps version selection local until deletion review", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const oldAct = globals.IS_REACT_ACT_ENVIRONMENT;
  const originalFetch = globalThis.fetch;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let requests = 0;
  globalThis.fetch = () => {
    requests++;
    return Promise.resolve(new Response(null, { status: 410 }));
  };
  const version: MediaVersion = {
    mediaId: 11,
    videoResolution: "1080",
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
    streamDetailsAvailable: true,
    fileSize: 100,
  };
  const candidate: SmartDuplicateCandidate = {
    mediaType: "movie",
    ratingKey: "movie-1",
    libraryKey: "movies",
    title: "Example",
    context: null,
    confidence: "obvious",
    keepMediaId: 11,
    deleteMediaIds: [12],
    reclaimableSize: 100,
    reasons: [],
    versions: [version, { ...version, mediaId: 12 }],
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let selected = candidate.keepMediaId;
  const render = () => (
    <CandidateFileDetails
      candidate={candidate}
      keepMediaId={selected}
      onKeepChange={(mediaId) => {
        selected = mediaId;
      }}
    />
  );
  try {
    await act(() => {
      renderer = TestRenderer.create(render());
    });
    assertEquals(renderer!.root.findAllByType("input").map((input) => input.props.checked), [
      true,
      false,
    ]);
    await act(() => renderer!.root.findAllByType("input")[1].props.onChange());
    assertEquals(selected, 12);
    await act(() => renderer!.update(render()));
    assertEquals(renderer!.root.findAllByType("input").map((input) => input.props.checked), [
      false,
      true,
    ]);
    assertEquals(requests, 0);
  } finally {
    await act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
    globals.IS_REACT_ACT_ENVIRONMENT = oldAct;
  }
});
