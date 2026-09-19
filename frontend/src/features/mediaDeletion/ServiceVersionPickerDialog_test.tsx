import { summarizeDuplicateComparisons } from "@shared/mediaComparison";
import { assertEquals } from "@std/assert";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import { DeletionDialogFooter, DeletionPreview } from "./DeletionDialog.tsx";
import type { DuplicateGroup, MediaVersion } from "../../lib/api.ts";
import {
  initialServiceVersionSelection,
  selectedServiceVersions,
  ServiceVersionPickerDialog,
  serviceVersionSelectionValid,
} from "./ServiceVersionPickerDialog.tsx";

function fixtureVersion(mediaId: number, fileSize: number, videoResolution: string): MediaVersion {
  return {
    mediaId,
    fileSize,
    videoResolution,
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
  };
}

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
  assertEquals(serviceVersionSelectionValid([episode], new Set(["episode:1", "episode:2"])), false);
  assertEquals(serviceVersionSelectionValid([episode], new Set(["episode:2"])), true);
  assertEquals(serviceVersionSelectionValid([movie], new Set(["movie:1", "movie:2"])), true);
  assertEquals(initialServiceVersionSelection([episode], true).size, 0);
  const sized = {
    ...movie,
    versions: [{ mediaId: 1, fileSize: 10 }, {
      mediaId: 2,
      fileSize: 20,
    }] as unknown as MediaVersion[],
  };
  assertEquals([...initialServiceVersionSelection([sized], false)], ["movie:1"]);
});

Deno.test("duplicate inline preview debounces selection and preserves picker state", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const oldAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const oldPreview = api.serviceDeletions.preview;
  const requests: unknown[] = [];
  api.serviceDeletions.preview = (request) => {
    requests.push(request.targets);
    return Promise.resolve({
      fingerprint: "test",
      canConfirm: true,
      arrConfigured: false,
      qbConfigured: false,
      targets: [],
    });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <ServiceVersionPickerDialog
            dialogRef={{ current: null }}
            groups={[{
              mediaType: "movie",
              ratingKey: "movie",
              libraryKey: "lib",
              title: "Example",
              thumb: null,
              year: null,
              combinedFileSize: 30,
              versions: [fixtureVersion(1, 10, "720"), fixtureVersion(2, 20, "1080")],
            }]}
            onCreated={() => {}}
            onCancel={() => {}}
          />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    assertEquals(requests.length, 0);
    const inputs = renderer!.root.findAllByType("input");
    assertEquals(inputs.map((input) => input.props.checked), [true, false]);
    assertEquals(renderer!.root.findAllByType(DeletionPreview).length, 0);
    await act(() => inputs[1].props.onChange());
    assertEquals(requests.length, 0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    assertEquals(requests, [[{ ratingKey: "movie" }]]);
    assertEquals(renderer!.root.findAllByType(DeletionPreview).length, 1);
    assertEquals(renderer!.root.findAllByType(DeletionDialogFooter).length, 1);
    assertEquals(renderer!.root.findAllByType("input")[0], inputs[0]);
    await act(() => renderer!.root.findAllByType("input")[1].props.onChange());
    assertEquals(renderer!.root.findByType(DeletionDialogFooter).props.confirmDisabled, true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    assertEquals(requests[1], [{ ratingKey: "movie", mediaId: 1 }]);
    assertEquals(renderer!.root.findAllByType("input")[0], inputs[0]);
  } finally {
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
    client.clear();
    api.serviceDeletions.preview = oldPreview;
    globals.IS_REACT_ACT_ENVIRONMENT = oldAct;
  }
});

Deno.test("season episode selection preserves the picker and expansion across toggles", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = api.serviceDeletions.preview;
  let requests = 0;
  api.serviceDeletions.preview = () => {
    requests++;
    return Promise.reject(new Error("Unexpected preview"));
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const episode = {
    mediaType: "episode" as const,
    episodeRatingKey: "episode",
    libraryKey: "tv",
    showRatingKey: "show",
    seasonRatingKey: "season",
    showTitle: "Example",
    showThumb: null,
    seasonIndex: 1,
    episodeIndex: 1,
    episodeTitle: "Pilot",
    combinedFileSize: 30,
    versions: [fixtureVersion(1, 10, "720"), fixtureVersion(2, 20, "1080")],
  };
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <ServiceVersionPickerDialog
            dialogRef={{ current: null }}
            groups={[episode]}
            season={{
              mediaType: "season",
              libraryKey: "tv",
              showRatingKey: "show",
              seasonRatingKey: "season",
              showTitle: "Example",
              showThumb: null,
              seasonIndex: 1,
              totalEpisodeCount: 1,
              duplicateGroupCount: 1,
              combinedFileSize: 30,
              reclaimableFileSize: 10,
              comparisonSummary: summarizeDuplicateComparisons([]),
              episodes: [episode],
            }}
            onCreated={() => {}}
            onCancel={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    const row = renderer!.root.findByType("details");
    assertEquals(row.findByType("strong").children.join(""), "E01 \u2014 Pilot");
    const inputs = renderer!.root.findAllByType("input");
    await act(() => inputs[0].props.onChange());
    assertEquals(renderer!.root.findByType("details"), row);
    assertEquals(renderer!.root.findAllByType("input")[1].props.disabled, true);
    assertEquals(requests, 0);
    await act(() => renderer!.root.findAllByType("input")[0].props.onChange());
    assertEquals(renderer!.root.findAllByType("input")[1].props.disabled, false);
  } finally {
    await act(() => renderer?.unmount());
    client.clear();
    api.serviceDeletions.preview = original;
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
