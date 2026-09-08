/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { api } from "../../lib/api.ts";
import { SeasonRemovalDialog } from "../../routes/-stale/SeasonRemovalDialog.tsx";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog.tsx";
import { DestinationOptions } from "./DeletionPlanSummary.tsx";
import { DeletionDialogFooter } from "./DeletionDialog.tsx";
import type {
  DownloadCleanupPreviewResponse,
  SeasonRemovalPreviewResponse,
  StaleItem,
} from "@shared/types";

const season: SeasonRemovalPreviewResponse = {
  fingerprint: "fixture",
  expiresAt: 9999999999,
  libraryKey: "tv",
  seasonRatingKey: "season",
  showRatingKey: "show",
  showTitle: "Fixture",
  seasonTitle: "Season 1",
  seasonIndex: 1,
  episodeCount: 1,
  fileSize: 100,
  coordinatedConfigured: true,
  sonarrStatus: "resolved",
  managedEpisodeCount: 1,
  monitoredEpisodeCount: 1,
  managedFileCount: 1,
  sonarrActionAvailable: true,
  plexFiles: [],
  sonarrFiles: [],
  cleanupConfigured: true,
  cleanupStatus: "unavailable",
  downloadJobs: [],
  blockers: [],
};

function options(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType(DestinationOptions).props.options as Array<{
    id: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
  }>;
}

Deno.test("season destinations start unchecked and failed refresh never removes consent", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = api.libraries.seasonRemovalPreview;
  const requests: Array<{ coordinated: boolean; cleanupDownloads: boolean }> = [];
  let fail = false;
  api.libraries.seasonRemovalPreview = (_library, _season, choice) => {
    requests.push(choice);
    return fail ? Promise.reject(new Error("Sonarr unavailable")) : Promise.resolve(season);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <SeasonRemovalDialog
            dialogRef={{ current: null }}
            libraryKey="tv"
            item={{ ratingKey: "season", title: "Fixture", seasonIndex: 1 } as StaleItem}
            pending={false}
            error={null}
            onConfirm={() => {}}
            onCancel={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assertEquals(requests[0], { coordinated: false, cleanupDownloads: false });
    assertEquals(options(renderer!).map(({ id, checked }) => [id, checked]), [
      ["arr", false],
      ["cleanup", false],
    ]);
    await act(() => {
      options(renderer!)[0].onChange(true);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assertEquals(requests.at(-1)?.coordinated, true);
    fail = true;
    await act(async () => {
      await client.invalidateQueries();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assertEquals(options(renderer!).find((option) => option.id === "arr")?.checked, true);
    assertEquals(renderer!.root.findByType(DeletionDialogFooter).props.confirmDisabled, true);
    fail = false;
    await act(() => {
      options(renderer!).find((option) => option.id === "arr")!.onChange(false);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assertEquals(requests.at(-1)?.coordinated, false);
  } finally {
    await act(() => {
      renderer?.unmount();
    });
    client.clear();
    api.libraries.seasonRemovalPreview = original;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

Deno.test("whole-item Arr choice cannot silently omit an unresolved bulk item", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = api.libraries.downloadCleanupPreview;
  api.libraries.downloadCleanupPreview = () =>
    Promise.resolve({
      coordinatedConfigured: true,
      downloadClientsConfigured: false,
      items: ["one", "two"].map((ratingKey) => ({
        ratingKey,
        status: "unavailable" as const,
        arrStatus: ratingKey === "one" ? "resolved" as const : "error" as const,
        arrReason: "Fixture lookup failure",
        arrTargets: [],
        downloadJobs: [],
        orphanFiles: [],
        retainedPaths: [],
        sources: [],
        plexPaths: [],
        plexPathsTruncated: false,
        plexPathStatus: "resolved" as const,
      })),
    });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <DeleteConfirmDialog
            dialogRef={{ current: null }}
            embedded
            libraryKey="tv"
            items={["one", "two"].map((ratingKey) => ({
              ratingKey,
              libraryKey: "tv",
              title: ratingKey,
              type: "show",
              fileSize: 100,
            }))}
            pending={false}
            error={null}
            onConfirm={() => {}}
            onCancel={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assertEquals(options(renderer!)[0].checked, false);
    assertEquals(renderer!.root.findByType(DeletionDialogFooter).props.confirmDisabled, false);
    await act(() => {
      options(renderer!)[0].onChange(true);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assertEquals(options(renderer!)[0].checked, true);
    assertEquals(renderer!.root.findByType(DeletionDialogFooter).props.confirmDisabled, true);
  } finally {
    await act(() => {
      renderer?.unmount();
    });
    client.clear();
    api.libraries.downloadCleanupPreview = original;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

Deno.test("changed QB evidence preserves the checkbox but requires renewed consent", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = api.libraries.downloadCleanupPreview;
  let fingerprint = "a".repeat(64);
  api.libraries.downloadCleanupPreview = () =>
    Promise.resolve({
      coordinatedConfigured: false,
      downloadClientsConfigured: true,
      items: [{
        ratingKey: "show",
        status: "resolved",
        arrStatus: "unavailable",
        qbittorrentOnlyStatus: "resolved",
        qbittorrentOnlyFingerprint: fingerprint,
        arrTargets: [],
        orphanFiles: [],
        retainedPaths: [],
        sources: [],
        plexPaths: [],
        plexPathsTruncated: false,
        plexPathStatus: "resolved",
        downloadJobs: [{
          jobId: "hash",
          provider: "qbittorrent",
          instanceKey: "qb",
          instanceName: "QB",
          name: "Fixture",
          size: 100,
          state: "uploading",
          uploaded: 100,
          ratio: 1,
          seedingTime: 60,
          completedAt: 1,
          contentPath: "/downloads/Fixture.mkv",
          savePath: "/downloads",
          trackerHost: null,
          sourcePath: "/downloads/Fixture.mkv",
          files: [],
          fileCount: 1,
          filesTruncated: false,
        }],
      }],
    } as DownloadCleanupPreviewResponse);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <DeleteConfirmDialog
            dialogRef={{ current: null }}
            embedded
            libraryKey="tv"
            items={[{
              ratingKey: "show",
              libraryKey: "tv",
              title: "Fixture",
              type: "show",
              fileSize: 100,
            }]}
            pending={false}
            error={null}
            onConfirm={() => {}}
            onCancel={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assertEquals(options(renderer!)[0].checked, false);
    await act(() => {
      options(renderer!)[0].onChange(true);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assertEquals(renderer!.root.findByType(DeletionDialogFooter).props.confirmDisabled, false);
    fingerprint = "b".repeat(64);
    await act(async () => {
      await client.invalidateQueries();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assertEquals(options(renderer!)[0].checked, true);
    assertEquals(renderer!.root.findByType(DeletionDialogFooter).props.confirmDisabled, true);
    await act(() => {
      options(renderer!)[0].onChange(false);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(() => {
      options(renderer!)[0].onChange(true);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assertEquals(renderer!.root.findByType(DeletionDialogFooter).props.confirmDisabled, false);
  } finally {
    await act(() => {
      renderer?.unmount();
    });
    client.clear();
    api.libraries.downloadCleanupPreview = original;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
