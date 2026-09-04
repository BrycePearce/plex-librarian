/// <reference lib="dom" />

import { assertEquals, assertStringIncludes } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Children, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
  rootFolderSuggestionListId,
  RootFolderSuggestionStatus,
  selectSuggestedRoot,
  startRootFolderDiscovery,
  storageCleanupCanSave,
  storageCleanupProblem,
  storageCleanupState,
  StorageCleanupStep,
} from "./ArrConnectionWizard.tsx";

type ElementProps = {
  children?: ReactNode;
  [key: string]: unknown;
};

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<ElementProps>) => boolean,
): ReactElement<ElementProps> | null {
  if (isValidElement<ElementProps>(node)) {
    if (predicate(node)) return node;
    return findElement(node.props.children, predicate);
  }
  if (node === null || node === undefined || typeof node !== "object") return null;
  for (const child of Children.toArray(node)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

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

const skipped = {
  libraryArrPath: "",
  libraryLocalPath: "/media",
  downloadArrPath: "",
  downloadLocalPath: "/downloads",
};

Deno.test("shared Arr setup ends with the storage cleanup step", () => {
  assertEquals(ARR_SETUP_STEPS, ["Connection", "Libraries", "Storage cleanup"]);
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
    ...skipped,
    ...update,
  };
}

Deno.test("the shared storage step renders Sonarr and Radarr labels with local-root defaults", () => {
  const sonarr = renderToStaticMarkup(
    <StorageCleanupStep type="sonarr" draft={draft()} onUpdate={() => {}} />,
  );
  for (
    const text of [
      "Historical hardlink cleanup",
      "Sonarr library root",
      "Sonarr download root",
      "Plex Librarian library root",
      "Plex Librarian download root",
      "Incomplete",
      'value="/media"',
      'value="/downloads"',
      "cannot create or change these mounts",
    ]
  ) assertStringIncludes(sonarr, text);

  const radarr = renderToStaticMarkup(
    <StorageCleanupStep
      type="radarr"
      draft={draft({
        libraryArrPath: "/data/media",
        downloadArrPath: "/data/torrents",
      })}
      onUpdate={() => {}}
    />,
  );
  assertStringIncludes(radarr, "Radarr library root");
  assertStringIncludes(radarr, "Configured");
});

Deno.test("Sonarr and Radarr storage cleanup is configured only with both complete pairs", () => {
  assertEquals(storageCleanupState(skipped), "incomplete");
  assertEquals(storageCleanupCanSave(skipped), true);
  assertEquals(
    storageCleanupState({
      ...skipped,
      libraryArrPath: "/data/media",
      downloadArrPath: "/data/torrents",
    }),
    "configured",
  );
});

Deno.test("a partial Arr mapping remains incomplete and cannot be submitted", () => {
  const partial = { ...skipped, libraryArrPath: "/data/media" };
  assertEquals(storageCleanupState(partial), "incomplete");
  assertEquals(storageCleanupCanSave(partial), false);
});

Deno.test("configured state mirrors existing local-root syntax and non-overlap validation", () => {
  const overlap = {
    ...skipped,
    libraryArrPath: "/data/media",
    downloadArrPath: "/data/torrents",
    downloadLocalPath: "/media/downloads",
  };
  assertEquals(storageCleanupState(overlap), "incomplete");
  assertEquals(storageCleanupCanSave(overlap), false);
  assertEquals(
    storageCleanupProblem(overlap),
    "The Plex Librarian library and download roots must not overlap.",
  );
  assertEquals(
    storageCleanupProblem({ ...overlap, downloadLocalPath: "D:\\Downloads" }),
    "Plex Librarian roots must be absolute Linux paths without parent traversal.",
  );
});

Deno.test("single-root discovery renders an explicit action without changing the draft", () => {
  const original = draft({ libraryArrPath: "/saved/library" });
  const discovery = rootFolderDiscoveryTransition(initialRootFolderDiscoveryState(), {
    type: "succeeded",
    revision: 0,
    roots: ["/data/TV"],
  });
  const html = renderToStaticMarkup(
    <StorageCleanupStep
      type="sonarr"
      draft={original}
      discovery={discovery}
      onUpdate={() => {}}
    />,
  );
  assertStringIncludes(html, "Suggested from Sonarr");
  assertStringIncludes(html, "Use /data/TV");
  assertStringIncludes(html, 'value="/saved/library"');
  assertEquals(selectSuggestedRoot("/data/TV"), { libraryArrPath: "/data/TV" });
  assertEquals(original.libraryArrPath, "/saved/library");
});

Deno.test("single-root Use and manual edits flow through the existing field update", () => {
  const updates: Array<Partial<ArrDraft>> = [];
  const storage = StorageCleanupStep({
    type: "sonarr",
    draft: draft({ libraryArrPath: "/saved/library" }),
    discovery: {
      revision: 0,
      attemptedRevision: 0,
      status: "suggested",
      roots: ["/data/TV"],
    },
    onUpdate: (update) => updates.push(update),
  });
  const suggestion = findElement(
    storage,
    (element) => element.type === RootFolderSuggestionStatus,
  );
  if (!suggestion) throw new Error("Expected suggestion status");
  const renderedSuggestion = RootFolderSuggestionStatus(
    suggestion.props as Parameters<typeof RootFolderSuggestionStatus>[0],
  );
  const useButton = findElement(
    renderedSuggestion,
    (element) => element.type === "button",
  );
  if (!useButton) throw new Error("Expected Use button");
  (useButton.props.onClick as () => void)();
  assertEquals(updates, [{ libraryArrPath: "/data/TV" }]);

  const libraryInput = findElement(
    storage,
    (element) => element.props.label === "Sonarr library root",
  );
  if (!libraryInput) throw new Error("Expected library path input");
  (libraryInput.props.onChange as (value: string) => void)("/manual/library");
  assertEquals(updates, [
    { libraryArrPath: "/data/TV" },
    { libraryArrPath: "/manual/library" },
  ]);
});

Deno.test("multiple roots are datalist suggestions on the editable input", () => {
  const discovery = rootFolderDiscoveryTransition(initialRootFolderDiscoveryState(), {
    type: "succeeded",
    revision: 0,
    roots: ["/data/TV", "/data/Anime"],
  });
  const html = renderToStaticMarkup(
    <StorageCleanupStep
      type="sonarr"
      draft={draft({ libraryArrPath: "/manual" })}
      discovery={discovery}
      onUpdate={() => {}}
    />,
  );
  assertStringIncludes(html, `list="${rootFolderSuggestionListId("sonarr")}"`);
  assertStringIncludes(html, '<option value="/data/TV"></option>');
  assertStringIncludes(html, '<option value="/data/Anime"></option>');
  assertStringIncludes(html, 'value="/manual"');
  assertStringIncludes(html, "/data/TV</code> may correspond to <code>/media/TV");
});

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
  assertEquals(rootFolderSuggestionListId("sonarr"), "arr-sonarr-library-root-suggestions");
});

Deno.test("manual, empty, failed, loading, and retry states remain advisory", () => {
  for (
    const [status, expected] of [
      ["manual", "replacement API key is required"],
      ["empty", "No configured roots found"],
      ["error", "Couldn’t load suggestions—enter the path manually"],
      ["loading", "Loading Radarr suggestions"],
    ] as const
  ) {
    const html = renderToStaticMarkup(
      <RootFolderSuggestionStatus
        appName="Radarr"
        discovery={{ revision: 2, attemptedRevision: 2, status, roots: [] }}
        onUse={() => {}}
        onRetry={() => {}}
      />,
    );
    assertStringIncludes(html, expected);
    if (status === "error") assertStringIncludes(html, "Retry");
  }
  const failed = rootFolderDiscoveryTransition(
    { revision: 2, attemptedRevision: 2, status: "loading", roots: [] },
    { type: "failed", revision: 2 },
  );
  assertEquals(
    rootFolderDiscoveryTransition(failed, { type: "started", revision: 2 }).status,
    "loading",
  );
  assertEquals(storageCleanupCanSave(skipped), true);
});

Deno.test("failed discovery retry action invokes only its current callback", () => {
  let sonarrRetries = 0;
  let radarrRetries = 0;
  const sonarrStatus = RootFolderSuggestionStatus({
    appName: "Sonarr",
    discovery: { revision: 3, attemptedRevision: 3, status: "error", roots: [] },
    onUse: () => {},
    onRetry: () => sonarrRetries++,
  });
  const retry = findElement(sonarrStatus, (element) => element.type === "button");
  if (!retry) throw new Error("Expected Retry button");
  (retry.props.onClick as () => void)();
  assertEquals(sonarrRetries, 1);
  assertEquals(radarrRetries, 0);

  RootFolderSuggestionStatus({
    appName: "Radarr",
    discovery: { revision: 3, attemptedRevision: 3, status: "error", roots: [] },
    onUse: () => {},
    onRetry: () => radarrRetries++,
  });
  assertEquals(radarrRetries, 0);
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
  assertEquals(drafts.sonarr.libraryArrPath, "");
  assertEquals(drafts.radarr.libraryArrPath, "");
  assertEquals(storageCleanupCanSave(drafts.sonarr), true);
  assertEquals(storageCleanupCanSave(drafts.radarr), true);
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
  assertEquals(storageCleanupCanSave(drafts.radarr), true);
  assertEquals(storageCleanupCanSave(drafts.sonarr), true);

  pending.sonarr.resolve({ roots: ["/tv"] });
  await flushPromises();
  assertEquals(states.sonarr.roots, ["/tv"]);
  assertEquals(states.radarr.status, "loading");
  pending.radarr.resolve({ roots: [] });
  await flushPromises();
  assertEquals(states.radarr.status, "empty");
});

Deno.test("the real Connection submit starts both discoveries and navigates without waiting", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const originalRootFolders = api.arr.rootFolders;
  const requests: Parameters<typeof api.arr.rootFolders>[0][] = [];
  const pending = deferred<{ roots: string[] }>();
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  api.arr.rootFolders = (request) => {
    requests.push(request);
    return pending.promise;
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
    assertEquals(renderer!.root.findByType("h4").children.join(""), "Select Plex libraries");
    const librariesNext = renderer!.root.findAllByType("button").find((button) =>
      button.children.join("") === "Next"
    );
    assertEquals(librariesNext?.props.disabled, false);

    await act(() => form.props.onSubmit({ preventDefault() {} }));
    const save = renderer!.root.findAllByType("button").find((button) =>
      button.children.join("").includes("Test and save")
    );
    assertEquals(save?.props.disabled, false);
    assertEquals(requests.length, 2);
  } finally {
    api.arr.rootFolders = originalRootFolders;
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
