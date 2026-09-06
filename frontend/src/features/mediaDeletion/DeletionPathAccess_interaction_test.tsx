/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { DeletionPathAccess } from "./DeletionPathAccess.tsx";
import { api } from "../../lib/api.ts";
import type { ArrIntegrationSettings } from "@shared/types";

Deno.test("focused access verifies the selected current file before saving and keeps failures blocked", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const priorAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const oldGet = api.arr.get, oldVerify = api.arr.verifyStorage, oldSave = api.arr.savePathMappings;
  const settings: ArrIntegrationSettings = {
    instances: [{
      id: 1,
      type: "sonarr",
      name: "Sonarr",
      url: "http://sonarr",
      apiKeyConfigured: true,
      pathMappings: [],
    }],
    mappings: [{ libraryKey: "tv", instanceId: 1, addImportExclusion: false }],
  };
  const requests: Parameters<typeof api.arr.verifyStorage>[0][] = [];
  let verified = false, saves = 0, resolved = 0;
  api.arr.get = () => Promise.resolve(settings);
  api.arr.verifyStorage = (request) => {
    requests.push(request);
    return Promise.resolve({
      status: verified ? "verified" : "unverified",
      reason: "Check selected file",
      library: { status: verified ? "verified" : "unavailable", reason: "Check selected file" },
      roots: [{
        kind: "library",
        arrPath: "/data/TV/Mad Men",
        localPath: "/media/Mad Men",
        status: verified ? "accessible" : "missing",
      }],
    });
  };
  api.arr.savePathMappings = (_id, mappings) => {
    saves++;
    return Promise.resolve({ ...settings.instances[0], pathMappings: mappings });
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["deletion-path-access", "tv"], settings);
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <DeletionPathAccess
            libraryKey="tv"
            ratingKey="mad-men"
            selectedPath="/data/TV/Mad Men/episode.mkv"
            reason="Verify Sonarr library path mapping"
            target={{
              instanceName: "Sonarr",
              type: "sonarr",
              title: "Mad Men",
              path: "/data/TV/Mad Men",
              seasons: null,
              mediaFiles: null,
              extraFiles: null,
            }}
            onResolved={() => {
              resolved++;
            }}
          />
        </QueryClientProvider>,
      );
    });
    await act(() =>
      renderer!.root.findByType("input").props.onChange({ target: { value: "/media/Mad Men" } })
    );
    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertEquals(saves, 0);
    assertEquals(resolved, 0);
    assertEquals(JSON.stringify(renderer!.toJSON()).includes("read-only"), true);
    assertEquals(requests[0].ratingKey, "mad-men");
    assertEquals(requests[0].selectedPath, "/data/TV/Mad Men/episode.mkv");
    assertEquals(requests[0].pathMappings, [{
      kind: "library",
      arrPath: "/data/TV/Mad Men",
      localPath: "/media/Mad Men",
    }]);
    verified = true;
    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertEquals(saves, 1);
    assertEquals(resolved, 1);
    assertEquals(settings.mappings[0].addImportExclusion, false);
  } finally {
    if (renderer) await act(() => renderer!.unmount());
    client.clear();
    api.arr.get = oldGet;
    api.arr.verifyStorage = oldVerify;
    api.arr.savePathMappings = oldSave;
    globals.IS_REACT_ACT_ENVIRONMENT = priorAct;
  }
});
