/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { ServicePathAccess } from "./ServicePathAccess.tsx";
import { api } from "../../lib/api.ts";
import type {
  DownloadCleanupJob,
  PlexPathMapping,
  QbittorrentIntegrationSettings,
} from "@shared/types";

Deno.test("focused service access refreshes saved mappings and repairs the service named by the blocker", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prior = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const oldPlexGet = api.settings.plexPathMappings;
  const oldPlexCreate = api.settings.createPlexPathMapping;
  const oldQbGet = api.qbittorrent.get;
  const plex: PlexPathMapping[] = [];
  let qb: QbittorrentIntegrationSettings = {
    envConfigured: true,
    instances: [],
    targets: [],
    pathMappings: [],
  };
  const job: DownloadCleanupJob = {
    provider: "qbittorrent",
    instanceKey: "env",
    instanceName: "QB",
    jobId: "job",
    name: "Mad Men",
    state: "uploading",
    size: 10,
    uploaded: 0,
    ratio: 0,
    seedingTime: 0,
    completedAt: null,
    contentPath: "/downloads/Mad Men",
    savePath: "/downloads",
    trackerHost: null,
    fileCount: 1,
    files: [{ path: "Mad Men/episode.mkv", size: 10 }],
    filesTruncated: false,
    sourcePath: null,
  };
  api.settings.plexPathMappings = () => Promise.resolve([...plex]);
  api.qbittorrent.get = () => Promise.resolve({ ...qb, pathMappings: [...qb.pathMappings] });
  api.settings.createPlexPathMapping = (request) => {
    const mapping: PlexPathMapping = {
      ...request,
      id: 1,
      serverId: 1,
      revision: 1,
      validationPlexPath: "/tv/Mad Men/episode.mkv",
      validationLocalPath: "/media/episode.mkv",
      validationSize: 10,
      validatedAt: 1,
    };
    plex.push(mapping);
    return Promise.resolve(mapping);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["deletion-plex-path-access", "tv"], []);
  client.setQueryData(["deletion-qb-path-access"], qb);
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let resolved = 0;
  const render = (reason: string) => (
    <QueryClientProvider client={client}>
      <ServicePathAccess
        libraryKey="tv"
        reason={reason}
        plexSample={{ ratingKey: "episode", mediaId: 1, path: "/tv/Mad Men/episode.mkv" }}
        job={job}
        onResolved={() => {
          resolved++;
        }}
      />
    </QueryClientProvider>
  );
  const text = () => JSON.stringify(renderer!.toJSON());
  try {
    await act(() => {
      renderer = TestRenderer.create(render("Verify the Plex library path mapping"));
    });
    assertEquals(text().includes('"Plex"," folder:'), true);
    await act(() =>
      renderer!.root.findByType("input").props.onChange({ target: { value: "/media" } })
    );
    await act(async () => {
      renderer!.root.findAllByType("button").at(-1)!.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assertEquals(resolved, 1);
    assertEquals(
      client.getQueryData<PlexPathMapping[]>(["deletion-plex-path-access", "tv"])?.length,
      1,
    );
    await act(() => renderer!.update(render("Verify that qBittorrent path mapping")));
    assertEquals(text().includes('"qBittorrent"," folder:'), true);
    qb = {
      ...qb,
      pathMappings: [{
        id: 1,
        instanceKey: "env",
        qbittorrentPath: "/downloads",
        localPath: "/broken",
        caseSensitive: true,
        revision: 1,
        validationQbittorrentPath: "/downloads/Mad Men/episode.mkv",
        validationLocalPath: "/broken/Mad Men/episode.mkv",
        validationSize: 10,
      }],
    };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["deletion-qb-path-access"] });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertEquals(renderer!.root.findByType("input").props.value, "/broken");
    await act(() => renderer!.update(render("Verify the Plex library path mapping")));
    assertEquals(renderer!.root.findByType("input").props.value, "/media");
  } finally {
    if (renderer) await act(() => renderer!.unmount());
    client.clear();
    api.settings.plexPathMappings = oldPlexGet;
    api.settings.createPlexPathMapping = oldPlexCreate;
    api.qbittorrent.get = oldQbGet;
    globals.IS_REACT_ACT_ENVIRONMENT = prior;
  }
});
