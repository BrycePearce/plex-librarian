/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import type { DuplicateGroup, MediaVersion, VersionDeletionPreviewResponse } from "@shared/types";
import { VersionPickerDialog } from "./VersionPickerDialog.tsx";
import { DestinationOptions } from "../../features/mediaDeletion/DeletionPlanSummary.tsx";
import { queryKeys } from "../../lib/queryKeys.ts";
import { api } from "../../lib/api.ts";
import { DeletionAccessResolver } from "../../features/mediaDeletion/DeletionAccessResolver.tsx";

Deno.test("duplicate QB selection survives refreshed Arr and cleanup verification failure", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prior = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const oldRefresh = api.duplicates.refreshTechnicalDetails;
  const oldMappings = api.settings.plexPathMappings;
  const oldQb = api.qbittorrent.get;
  api.settings.plexPathMappings = () => Promise.resolve([]);
  api.qbittorrent.get = () =>
    Promise.resolve({ envConfigured: true, instances: [], targets: [], pathMappings: [] });
  api.duplicates.refreshTechnicalDetails = () =>
    Promise.reject(new Error("fixture has no technical refresh"));
  const versions = [1, 2].map((mediaId) => ({
    mediaId,
    fileSize: mediaId * 100,
    audioStreams: [],
    subtitleStreams: [],
    streamDetailsAvailable: true,
    videoResolution: "1080",
    width: 1920,
    height: 1080,
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
  } satisfies MediaVersion));
  const item: DuplicateGroup = {
    mediaType: "episode",
    libraryKey: "tv",
    episodeRatingKey: "episode",
    showRatingKey: "show",
    seasonRatingKey: "season",
    showTitle: "Mad Men",
    showThumb: null,
    seasonIndex: 1,
    episodeIndex: 1,
    episodeTitle: "Pilot",
    combinedFileSize: 300,
    versions,
  };
  const preview: VersionDeletionPreviewResponse = {
    mediaType: "episode",
    arrService: "sonarr",
    availableVersions: [],
    versions: [{
      mediaId: 1,
      plexPaths: ["/tv/A.mkv"],
      arrPaths: ["/tv/A.mkv"],
      cleanupPaths: [],
      status: "resolved",
      truncated: false,
      arrStatus: "resolved",
      cleanupStatus: "resolved",
    }],
    arrConfigured: true,
    arrStatus: "unavailable",
    arrTargets: [],
    arrSelectionMatched: true,
    arrReassignStatus: "resolved",
    radarrPathAdoption: { mode: "unavailable", requiresConsent: false },
    cleanupConfigured: true,
    cleanupStatus: "resolved",
    sonarrCleanupStatus: "resolved",
    downloadJobs: [{
      provider: "qbittorrent",
      instanceKey: "env",
      instanceName: "QB",
      jobId: "hash",
      name: "Pilot",
      state: "uploading",
      size: 100,
      uploaded: 0,
      ratio: 0,
      seedingTime: 0,
      completedAt: null,
      contentPath: "/downloads/A.mkv",
      savePath: "/downloads",
      trackerHost: null,
      fileCount: 1,
      files: [{ path: "A.mkv", size: 100 }],
      filesTruncated: false,
      sourcePath: null,
    }],
    orphanFiles: [],
    retainedPaths: [],
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const key = queryKeys.versionDeletionPreview.forVersions("episode", "episode", [1], true);
  client.setQueryData(key, preview);
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <VersionPickerDialog
            dialogRef={{ current: null }}
            item={item}
            pending={false}
            error={null}
            onConfirm={() => {
              throw new Error("No fixture deletion allowed");
            }}
            onCancel={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    const cleanup = () =>
      renderer!.root.findByType(DestinationOptions).props.options
        .find((option: { id: string }) => option.id === "cleanup");
    await act(() => cleanup().onChange(true));
    assertEquals(cleanup().checked, true);
    await act(async () => {
      client.setQueryData(key, {
        ...preview,
        arrReason: "Sonarr deletion is series-wide",
        cleanupStatus: "unavailable",
        cleanupReason: "A retained Plex path has no single validated local mapping: /archive/B.mkv",
        availableVersions: [...preview.versions, {
          ...preview.versions[0],
          mediaId: 2,
          plexPaths: ["/archive/B.mkv"],
        }],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertEquals(renderer!.root.findByType(DeletionAccessResolver).props.plexSample, {
      ratingKey: "episode",
      mediaId: 2,
      path: "/archive/B.mkv",
    });
    assertEquals(cleanup().checked, true);
    await act(async () => {
      client.setQueryData(key, {
        ...preview,
        arrReassignStatus: "error",
        cleanupStatus: "error",
        sonarrCleanupStatus: "error",
        sonarrCleanupReason: "QB is offline",
        downloadJobs: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertEquals(cleanup().checked, true);
    const deleteButton = renderer!.root.findAllByType("button")
      .find((button) => button.props.className?.includes("btn-error"));
    assertEquals(deleteButton?.props.disabled, true);
  } finally {
    if (renderer) await act(() => renderer!.unmount());
    client.clear();
    api.duplicates.refreshTechnicalDetails = oldRefresh;
    api.settings.plexPathMappings = oldMappings;
    api.qbittorrent.get = oldQb;
    globals.IS_REACT_ACT_ENVIRONMENT = prior;
  }
});
