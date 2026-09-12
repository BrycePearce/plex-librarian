/// <reference lib="dom" />
import { connectionTestLabel } from "./ArrConnectionWizard.tsx";

import { assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @ts-types="@types/react-test-renderer"
import TestRenderer, { act } from "react-test-renderer";
import { api } from "../../lib/api.ts";
import {
  ARR_SETUP_STEPS,
  ArrConnectionWizard,
  type ArrDraft,
  automaticRootFolderDiscoveryTypes,
  initialRootFolderDiscoveryState,
  rootFolderDiscoveryPlan,
  rootFolderDiscoveryTransition,
  startRootFolderDiscovery,
} from "./ArrConnectionWizard.tsx";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

Deno.test("shared Arr setup contains only connection and libraries", () => {
  assertEquals(ARR_SETUP_STEPS, ["Connection", "Libraries"]);
});

function draft(update: Partial<ArrDraft> = {}): ArrDraft {
  return {
    instanceId: null,
    name: "Arr",
    url: "http://arr:8989",
    apiKey: "secret",
    urlWasSuggested: false,
    libraryKeys: new Set(),
    addImportExclusion: true,
    ...update,
  };
}

Deno.test("discovery planning protects stored keys and keeps applications independent", () => {
  const instances = [
    {
      id: 7,
      type: "sonarr" as const,
      name: "Sonarr",
      url: "http://sonarr:8989",
      apiKeyConfigured: true,
      pathMappings: [],
    },
  ];
  assertEquals(
    rootFolderDiscoveryPlan(
      "sonarr",
      draft({ instanceId: 7, url: "http://sonarr:8989/", apiKey: "" }),
      instances,
    ),
    { kind: "request", request: { instanceId: 7, url: "http://sonarr:8989" } },
  );
  assertEquals(
    rootFolderDiscoveryPlan(
      "sonarr",
      draft({ instanceId: 7, url: "http://edited:8989", apiKey: "" }),
      instances,
    ),
    { kind: "manual" },
  );
  assertEquals(
    rootFolderDiscoveryPlan(
      "sonarr",
      draft({ instanceId: 7, url: "http://edited:8989", apiKey: "replacement" }),
      instances,
    ),
    {
      kind: "request",
      request: { instanceId: 7, url: "http://edited:8989", apiKey: "replacement" },
    },
  );
});

Deno.test("credential revisions invalidate only one app and reject stale responses", () => {
  const sonarr = rootFolderDiscoveryTransition(initialRootFolderDiscoveryState(), {
    type: "credentials-changed",
  });
  const radarr = rootFolderDiscoveryTransition(initialRootFolderDiscoveryState(), {
    type: "succeeded",
    revision: 0,
    roots: ["/movies"],
  });
  assertEquals(sonarr, { revision: 1, attemptedRevision: null, status: "idle", roots: [] });
  assertEquals(radarr.roots, ["/movies"]);
  assertEquals(
    rootFolderDiscoveryTransition(sonarr, {
      type: "succeeded",
      revision: 0,
      roots: ["/stale-secret-looking-value"],
    }),
    sonarr,
  );
});

Deno.test("one advance can start independent eligible Sonarr and Radarr discoveries once", () => {
  const drafts = {
    sonarr: draft({ name: "Sonarr", url: "http://sonarr:8989", apiKey: "sonarr-key" }),
    radarr: draft({ name: "Radarr", url: "http://radarr:7878", apiKey: "radarr-key" }),
  };
  const discoveries = {
    sonarr: initialRootFolderDiscoveryState(),
    radarr: initialRootFolderDiscoveryState(),
  };
  assertEquals(automaticRootFolderDiscoveryTypes(drafts, [], discoveries), ["radarr", "sonarr"]);
  assertEquals(
    automaticRootFolderDiscoveryTypes(drafts, [], {
      ...discoveries,
      radarr: { ...discoveries.radarr, attemptedRevision: 0 },
    }),
    ["sonarr"],
  );
});

Deno.test("one advance launches both discoveries without waiting for either response", async () => {
  const drafts = {
    sonarr: draft({ name: "Sonarr", url: "http://sonarr:8989", apiKey: "sonarr-key" }),
    radarr: draft({ name: "Radarr", url: "http://radarr:7878", apiKey: "radarr-key" }),
  };
  const states = {
    sonarr: initialRootFolderDiscoveryState(),
    radarr: initialRootFolderDiscoveryState(),
  };
  const pending = {
    sonarr: deferred<{ roots: string[] }>(),
    radarr: deferred<{ roots: string[] }>(),
  };
  const requests: Array<{ type: "radarr" | "sonarr"; url: string }> = [];

  for (const type of automaticRootFolderDiscoveryTypes(drafts, [], states)) {
    const started = startRootFolderDiscovery(
      type,
      drafts[type],
      [],
      states[type],
      (request) => {
        requests.push({ type, url: request.url });
        return pending[type].promise;
      },
      (event) => states[type] = rootFolderDiscoveryTransition(states[type], event),
    );
    assertEquals(started, true);
  }

  assertEquals(requests, [
    { type: "radarr", url: "http://radarr:7878" },
    { type: "sonarr", url: "http://sonarr:8989" },
  ]);
  assertEquals(states.radarr.status, "loading");
  assertEquals(states.sonarr.status, "loading");

  pending.sonarr.resolve({ roots: ["/tv"] });
  await flushPromises();
  assertEquals(states.sonarr.roots, ["/tv"]);
  assertEquals(states.radarr.status, "loading");
  pending.radarr.resolve({ roots: [] });
  await flushPromises();
  assertEquals(states.radarr.status, "empty");
});

Deno.test("automatic connection setup preserves saved paths without a local access editor", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const oldEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const existingMappings = [
    { kind: "library" as const, arrPath: "/tv", localPath: "/media" },
    { kind: "library" as const, arrPath: "/anime", localPath: "/animation" },
    { kind: "download" as const, arrPath: "/downloads", localPath: "/payloads" },
    { kind: "download" as const, arrPath: "/archive", localPath: "/archive-copy" },
  ];
  const originalVerify = api.arr.verifyStorage;
  const originalUpdate = api.arr.updateInstance;
  const updates: Parameters<typeof api.arr.updateInstance>[1][] = [];
  api.arr.updateInstance = (_id, value) => {
    updates.push(value);
    return Promise.resolve({
      id: 7,
      type: "sonarr",
      name: "Sonarr",
      url: "http://sonarr",
      apiKeyConfigured: true,
      pathMappings: value.pathMappings ?? [],
    });
  };
  const originalRoots = api.arr.rootFolders;
  const originalStorage = api.qbittorrent.storagePaths;
  const first = deferred<Awaited<ReturnType<typeof api.arr.verifyStorage>>>();
  const second = deferred<Awaited<ReturnType<typeof api.arr.verifyStorage>>>();
  let calls = 0;
  api.arr.verifyStorage = (request) => {
    assertEquals(request.pathMappings.length, 1);
    assertEquals(request.pathMappings[0].kind, "library");
    return ++calls === 1 ? first.promise : second.promise;
  };
  api.arr.rootFolders = () => Promise.resolve({ roots: ["/tv"] });
  api.qbittorrent.storagePaths = () => Promise.resolve({ paths: [] });
  const queryClient = new QueryClient();
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient}>
          <ArrConnectionWizard
            data={{
              instances: [{
                id: 7,
                type: "sonarr",
                name: "Sonarr",
                url: "http://sonarr",
                apiKeyConfigured: true,
                pathMappings: existingMappings,
              }],
              mappings: [],
            }}
            libraryData={undefined}
            librariesLoading={false}
            librariesError={null}
            initialType="sonarr"
            editingInstanceId={7}
            onCancel={() => {}}
            onSaved={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    const submit = () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    await act(async () => {
      submit();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertEquals(calls, 0, "normal connection setup does not inspect storage");
    const rendered = JSON.stringify(renderer!.toJSON());
    assertEquals(rendered.includes("Optional path access"), false);
    assertEquals(rendered.includes("Plex Librarian library root"), false);
    assertEquals(rendered.includes("Plex Librarian download root"), false);
    assertEquals(
      JSON.stringify(renderer!.toJSON()).includes("Host discovery identifies paths"),
      true,
    );
    const saveButton = renderer!.root.findAllByType("button").find((button) =>
      button.props.type === "submit"
    );
    assertEquals(saveButton?.props.disabled, false);
    assertEquals(calls, 0);
    await act(async () => {
      submit();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertEquals(updates.length, 1);
    assertEquals(updates[0].pathMappings, existingMappings);
  } finally {
    if (renderer) await act(() => renderer!.unmount());
    queryClient.clear();
    api.arr.verifyStorage = originalVerify;
    api.arr.updateInstance = originalUpdate;
    api.arr.rootFolders = originalRoots;
    api.qbittorrent.storagePaths = originalStorage;
    globals.IS_REACT_ACT_ENVIRONMENT = oldEnvironment;
  }
});

Deno.test("the real Connection submit starts both discoveries and navigates without waiting", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const originalRootFolders = api.arr.rootFolders;
  const originalStoragePaths = api.qbittorrent.storagePaths;
  const requests: Parameters<typeof api.arr.rootFolders>[0][] = [];
  const pending = deferred<{ roots: string[] }>();
  const storagePending = deferred<{ paths: string[] }>();
  let storageRequests = 0;
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  api.arr.rootFolders = (request) => {
    requests.push(request);
    return pending.promise;
  };
  api.qbittorrent.storagePaths = () => {
    storageRequests++;
    return storagePending.promise;
  };

  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient}>
          <ArrConnectionWizard
            data={{
              instances: [
                {
                  id: 7,
                  type: "sonarr",
                  name: "Sonarr",
                  url: "http://sonarr:8989",
                  apiKeyConfigured: true,
                  pathMappings: [],
                },
                {
                  id: 8,
                  type: "radarr",
                  name: "Radarr",
                  url: "http://radarr:7878",
                  apiKeyConfigured: true,
                  pathMappings: [],
                },
              ],
              mappings: [],
            }}
            libraryData={{
              limit: 2,
              offset: 0,
              total: 2,
              libraries: [
                {
                  key: "shows",
                  title: "Shows",
                  type: "show",
                  syncedAt: 1,
                  historySyncedAt: 1,
                  staleMinAgeDays: null,
                  automaticStaleDays: 180,
                  automaticQuickCleanupDays: 30,
                  itemCount: 1,
                  totalFileSize: 1,
                },
                {
                  key: "movies",
                  title: "Movies",
                  type: "movie",
                  syncedAt: 1,
                  historySyncedAt: 1,
                  staleMinAgeDays: null,
                  automaticStaleDays: 180,
                  automaticQuickCleanupDays: 30,
                  itemCount: 1,
                  totalFileSize: 1,
                },
              ],
            }}
            librariesLoading={false}
            librariesError={null}
            initialType="sonarr"
            editingInstanceId={7}
            onCancel={() => {}}
            onSaved={() => {}}
          />
        </QueryClientProvider>,
      );
    });

    const form = renderer!.root.findByType("form");
    await act(() => form.props.onSubmit({ preventDefault() {} }));

    assertEquals(requests, [
      { instanceId: 8, url: "http://radarr:7878" },
      { instanceId: 7, url: "http://sonarr:8989" },
    ]);
    assertEquals(storageRequests, 0);
    assertEquals(renderer!.root.findAllByType("h4")[0].children.join(""), "Select Plex libraries");
    const librariesNext = renderer!.root.findAllByType("button").find((button) =>
      button.props.type === "submit"
    );
    assertEquals(librariesNext?.props.disabled, false);

    const save = renderer!.root.findAllByType("button").find((button) =>
      button.children.join("").includes("Test and save")
    );
    assertEquals(save?.props.disabled, false);
    assertEquals(requests.length, 2);
    assertEquals(storageRequests, 0);
    await act(async () => {
      storagePending.resolve({ paths: ["/data/.torrents/complete"] });
      pending.resolve({ roots: ["/data/TV"] });
      await flushPromises();
    });
  } finally {
    api.arr.rootFolders = originalRootFolders;
    api.qbittorrent.storagePaths = originalStoragePaths;
    await act(() => renderer?.unmount());
    queryClient.clear();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

Deno.test("credential changes ignore an in-flight result and retry the current revision", async () => {
  const first = deferred<{ roots: string[] }>();
  const second = deferred<{ roots: string[] }>();
  let state = initialRootFolderDiscoveryState();
  const requests: string[] = [];
  const dispatch = (event: Parameters<typeof rootFolderDiscoveryTransition>[1]) => {
    state = rootFolderDiscoveryTransition(state, event);
  };

  startRootFolderDiscovery(
    "sonarr",
    draft(),
    [],
    state,
    (request) => {
      requests.push(request.url);
      return first.promise;
    },
    dispatch,
  );
  dispatch({ type: "credentials-changed" });
  first.resolve({ roots: ["/stale"] });
  await flushPromises();
  assertEquals(state, { revision: 1, attemptedRevision: null, status: "idle", roots: [] });

  const currentDraft = draft({ url: "http://new-sonarr:8989" });
  startRootFolderDiscovery(
    "sonarr",
    currentDraft,
    [],
    state,
    (request) => {
      requests.push(request.url);
      return second.promise;
    },
    dispatch,
    true,
  );
  second.reject(new Error("offline"));
  await flushPromises();
  assertEquals(requests, ["http://arr:8989", "http://new-sonarr:8989"]);
  assertEquals(state.revision, 1);
  assertEquals(state.status, "error");
});

Deno.test("connection test status follows credential revision and ignores stale responses", () => {
  let state = initialRootFolderDiscoveryState();
  assertEquals(connectionTestLabel(state), "Not tested");
  state = rootFolderDiscoveryTransition(state, { type: "started", revision: 0 });
  assertEquals(connectionTestLabel(state), "Testing…");
  state = rootFolderDiscoveryTransition(state, { type: "succeeded", revision: 0, roots: [] });
  assertEquals(connectionTestLabel(state), "Connected");
  state = rootFolderDiscoveryTransition(state, { type: "credentials-changed" });
  state = rootFolderDiscoveryTransition(state, { type: "succeeded", revision: 0, roots: ["/old"] });
  assertEquals(connectionTestLabel(state), "Not tested");
  state = rootFolderDiscoveryTransition(state, { type: "failed", revision: 1 });
  assertEquals(connectionTestLabel(state), "Connection failed");
});
