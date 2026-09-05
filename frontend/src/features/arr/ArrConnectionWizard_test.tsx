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
  commonPosixRoot,
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
  storageCleanupSuggestion,
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
      "Clean up leftover files",
      "Sonarr library root",
      "Sonarr download root",
      "Plex Librarian library root",
      "Plex Librarian download root",
      "Optional",
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
  assertStringIncludes(radarr, "Suggested");
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

Deno.test("connected services produce one confirmable storage proposal", () => {
  assertEquals(commonPosixRoot(["/data/Anime", "/data/TV"]), "/data");
  assertEquals(
    storageCleanupSuggestion(
      ["/data/Anime", "/data/TV"],
      ["/data/.torrents/complete", "/data/.torrents/complete"],
    ),
    {
      libraryArrPath: "/data",
      libraryLocalPath: "/media",
      downloadArrPath: "/data/.torrents/complete",
      downloadLocalPath: "/downloads",
    },
  );
  assertEquals(storageCleanupSuggestion(["/TV"], ["/one", "/two"]), null);
  assertEquals(
    storageCleanupSuggestion(
      ["/data/TV"],
      ["/data/.torrents/complete", "/data/.torrents/complete/tv"],
    )?.downloadArrPath,
    "/data/.torrents/complete",
  );
  assertEquals(storageCleanupSuggestion(["/TV"], ["/data/down", "/data/downloads"]), null);
  assertEquals(storageCleanupSuggestion(["C:\\TV"], ["C:\\Downloads"]), null);
});

Deno.test("suggested setup waits for confirmation and preserves manual mappings", () => {
  const updates: Array<Partial<ArrDraft>> = [];
  const suggestionProps = {
    type: "sonarr" as const,
    draft: draft(),
    discovery: {
      revision: 0,
      attemptedRevision: 0,
      status: "suggested" as const,
      roots: ["/data/Anime", "/data/TV"],
    },
    storagePaths: {
      status: "suggested" as const,
      paths: ["/data/.torrents/complete"],
    },
    onUpdate: (update: Partial<ArrDraft>) => updates.push(update),
  };
  const suggestion = StorageCleanupStep(suggestionProps);
  const html = renderToStaticMarkup(suggestion);
  assertStringIncludes(html, "Paths found in Sonarr and qBittorrent");
  assertStringIncludes(html, "enables verified historical hardlink");
  assertStringIncludes(html, "Local mount paths are suggestions, not verified mappings");
  assertEquals(html.includes("complete recovery"), false);
  assertStringIncludes(html, "path Sonarr sees");
  assertStringIncludes(html, "/data");
  assertStringIncludes(html, "/data/.torrents/complete");
  assertEquals(updates, []);
  const confirm = findElement(
    suggestion,
    (element) => element.type === "button" && element.props.children === "Use detected paths",
  );
  if (!confirm) throw new Error("Expected confirmation action");
  (confirm.props.onClick as () => void)();
  assertEquals(updates, [{
    libraryArrPath: "/data",
    libraryLocalPath: "/media",
    downloadArrPath: "/data/.torrents/complete",
    downloadLocalPath: "/downloads",
  }]);

  const manual = renderToStaticMarkup(
    <StorageCleanupStep
      {...suggestionProps}
      draft={draft({
        libraryArrPath: "/custom/library",
        downloadArrPath: "/custom/downloads",
      })}
    />,
  );
  assertEquals(manual.includes("Use detected paths"), false);
  assertStringIncludes(manual, 'value="/custom/library"');
  assertStringIncludes(manual, 'value="/custom/downloads"');

  const editedLocal = renderToStaticMarkup(
    <StorageCleanupStep
      {...suggestionProps}
      draft={draft({ libraryLocalPath: "/custom-media" })}
    />,
  );
  assertEquals(editedLocal.includes("Use detected paths"), false);
  assertStringIncludes(editedLocal, 'value="/custom-media"');
});

Deno.test("detected paths distinguish suggestions from verification and can be skipped", () => {
  const updates: Array<Partial<ArrDraft>> = [];
  const props = {
    type: "sonarr" as const,
    draft: draft({ libraryArrPath: "/data", downloadArrPath: "/data/downloads" }),
    discovery: {
      revision: 0,
      attemptedRevision: 0,
      status: "suggested" as const,
      roots: ["/data/TV", "/data/Anime"],
    },
    storagePaths: { status: "suggested" as const, paths: ["/data/downloads"] },
    onUpdate: (update: Partial<ArrDraft>) => updates.push(update),
  };
  const step = StorageCleanupStep(props);
  const html = renderToStaticMarkup(step);
  assertStringIncludes(html, "Auto-detected");
  assertStringIncludes(html, "From QB");
  assertStringIncludes(html, "Suggested");
  assertEquals(html.includes(">Verified<"), false);
  const verified = renderToStaticMarkup(
    <StorageCleanupStep
      {...props}
      verification={{ result: { status: "verified", reason: "Sample matched" } }}
    />,
  );
  assertStringIncludes(verified, ">Verified<");
  assertEquals(verified.includes(">Suggested<"), false);
  const edited = renderToStaticMarkup(
    <StorageCleanupStep {...props} draft={draft({ libraryArrPath: "/custom" })} />,
  );
  assertEquals(edited.includes("Auto-detected"), false);
  assertEquals(edited.includes("From QB"), false);
  const skip = findElement(
    step,
    (element) => element.type === "button" && element.props.children === "Skip storage cleanup",
  );
  if (!skip) throw new Error("Expected skip action");
  (skip.props.onClick as () => void)();
  assertEquals(updates, [skipped]);
  assertEquals(storageCleanupCanSave({ ...props.draft, ...updates[0] }), true);
});

Deno.test("qBittorrent discovery stays simple while loading and explains manual fallbacks", () => {
  const base = {
    type: "sonarr" as const,
    draft: draft(),
    onUpdate: () => {},
  };
  const loading = renderToStaticMarkup(
    <StorageCleanupStep
      {...base}
      storagePaths={{ status: "loading", paths: [] }}
    />,
  );
  assertStringIncludes(loading, "Checking connected services");
  assertStringIncludes(loading, "Sonarr download root");
  assertStringIncludes(loading, "How to match your folders");
  assertEquals(loading.includes('<details open=""'), false);

  const arrLoading = renderToStaticMarkup(
    <StorageCleanupStep
      {...base}
      discovery={{
        revision: 0,
        attemptedRevision: 0,
        status: "loading",
        roots: [],
      }}
      storagePaths={{ status: "suggested", paths: ["/downloads"] }}
    />,
  );
  assertStringIncludes(arrLoading, "Checking connected services");
  assertStringIncludes(arrLoading, "Sonarr download root");
  assertEquals(arrLoading.includes('<details open=""'), false);

  const empty = renderToStaticMarkup(
    <StorageCleanupStep {...base} storagePaths={{ status: "empty", paths: [] }} />,
  );
  assertStringIncludes(empty, "qBittorrent is optional");
  assertStringIncludes(empty, "How to match your folders");

  const ambiguous = renderToStaticMarkup(
    <StorageCleanupStep
      {...base}
      storagePaths={{ status: "suggested", paths: ["/one", "/two"] }}
    />,
  );
  assertStringIncludes(ambiguous, "Detected: /one, /two");
  assertStringIncludes(ambiguous, '<option value="/one"></option>');
  assertStringIncludes(ambiguous, '<option value="/two"></option>');

  const radarr = renderToStaticMarkup(
    <StorageCleanupStep
      {...base}
      type="radarr"
      discovery={{
        revision: 0,
        attemptedRevision: 0,
        status: "suggested",
        roots: ["/data/Movies"],
      }}
      storagePaths={{ status: "suggested", paths: ["/data/.torrents/complete"] }}
    />,
  );
  assertStringIncludes(radarr, "Paths found in Radarr and qBittorrent");

  let retries = 0;
  const failed = StorageCleanupStep({
    ...base,
    storagePaths: { status: "error", paths: [] },
    onStorageRetry: () => retries++,
  });
  const retry = findElement(
    failed,
    (element) => element.type === "button" && element.props.children === "Retry",
  );
  if (!retry) throw new Error("Expected storage discovery retry action");
  (retry.props.onClick as () => void)();
  assertEquals(retries, 1);
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

Deno.test("storage verification runs automatically and ignores results after paths change", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const oldEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const originalVerify = api.arr.verifyStorage;
  const originalRoots = api.arr.rootFolders;
  const originalStorage = api.qbittorrent.storagePaths;
  const first = deferred<Awaited<ReturnType<typeof api.arr.verifyStorage>>>();
  const second = deferred<Awaited<ReturnType<typeof api.arr.verifyStorage>>>();
  let calls = 0;
  api.arr.verifyStorage = () => ++calls === 1 ? first.promise : second.promise;
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
                pathMappings: [
                  { kind: "library", arrPath: "/tv", localPath: "/media" },
                  { kind: "download", arrPath: "/data/downloads", localPath: "/downloads" },
                ],
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
    await act(submit);
    await act(submit);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    assertEquals(calls, 1);
    await act(() =>
      renderer!.root.findByType(StorageCleanupStep).props.onUpdate({
        downloadArrPath: "/other/downloads",
      })
    );
    await act(() => first.resolve({ status: "verified", reason: "Stale verification" }));
    assertEquals(JSON.stringify(renderer!.toJSON()).includes("Stale verification"), false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    assertEquals(calls, 2);
    await act(() => second.resolve({ status: "unverified", reason: "No current sample" }));
    assertEquals(JSON.stringify(renderer!.toJSON()).includes("No current sample"), true);
    const save = renderer!.root.findAllByType("button").find((button) =>
      button.children.join("").includes("Test and save")
    );
    assertEquals(save?.props.disabled, false);
  } finally {
    if (renderer) await act(() => renderer!.unmount());
    queryClient.clear();
    api.arr.verifyStorage = originalVerify;
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
    assertEquals(storageRequests, 1);
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
    assertEquals(storageRequests, 1);
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
