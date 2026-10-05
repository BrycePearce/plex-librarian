import { assertEquals, assertRejects } from "@std/assert";
import { api, ApiError } from "./api.ts";
import type { ServiceDeletionRequest } from "../../../shared/serviceOwnedDeletion.ts";

Deno.test("duplicate directory and on-demand previews use separate reads and preserve filters", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (url) => {
    requests.push(String(url));
    return Promise.resolve(
      Response.json({ groups: [{ mediaType: "season", seasonRatingKey: "season/1" }] }),
    );
  };
  try {
    await api.duplicates.directory({
      type: "tv",
      comparison: "different",
      search: "A & B",
      offset: 50,
    });
    await api.duplicates.seasonPreview("season/1", "different", "A & B");
    const directory = new URL(requests[0], "http://fixture").searchParams;
    assertEquals(directory.get("includeSeasonDetails"), "false");
    assertEquals(directory.get("offset"), "50");
    const detail = new URL(requests[1], "http://fixture").searchParams;
    assertEquals(detail.get("seasonRatingKey"), "season/1");
    assertEquals(detail.get("comparison"), "different");
    assertEquals(detail.get("search"), "A & B");
    assertEquals(detail.get("includeSeasonDetails"), null);
    globalThis.fetch = () => Promise.resolve(Response.json({ groups: [] }));
    await assertRejects(
      () => api.duplicates.seasonPreview("gone", "all", ""),
      Error,
      "no longer matches",
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("service-owned requests preserve reviewed identity and independent destinations", async () => {
  const originalFetch = globalThis.fetch;
  const request: ServiceDeletionRequest = {
    libraryKey: "movies",
    targets: [{ ratingKey: "movie/1", mediaId: 11 }],
    arrSelected: true,
    qbSelected: false,
    clientRequestId: "stable-request-id",
    previewFingerprint: "reviewed-fingerprint",
    consentToken: "reviewed-consent",
  };
  const controller = new AbortController();
  const captured: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (url, init) => {
    captured.push({ url, init });
    return Promise.resolve(Response.json({ operationId: "operation-1", status: "queued" }));
  };
  try {
    const {
      clientRequestId: _id,
      previewFingerprint: _fingerprint,
      consentToken: _token,
      ...choices
    } = request;
    await api.serviceDeletions.preview(choices, controller.signal);
    await api.serviceDeletions.create(request);
    assertEquals(captured.map(({ url }) => url), [
      "/api/service-deletions/preview",
      "/api/service-deletions",
    ]);
    assertEquals(captured[0].init?.signal, controller.signal);
    assertEquals(JSON.parse(String(captured[0].init?.body)), choices);
    assertEquals(captured[1].init?.method, "POST");
    assertEquals(JSON.parse(String(captured[1].init?.body)), request);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("service-owned conflicts retain the operation id and error code", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      error: "already reserved",
      operationId: "existing-operation",
      code: "RESERVATION_CONFLICT",
    }, { status: 409 }));
  try {
    const error = await assertRejects(
      () =>
        api.serviceDeletions.preview({
          libraryKey: "movies",
          targets: [{ ratingKey: "movie-1" }],
          arrSelected: false,
          qbSelected: false,
        }),
      ApiError,
      "Already reserved",
    );
    assertEquals(error.operationId, "existing-operation");
    assertEquals(error.code, "RESERVATION_CONFLICT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("storage verification posts mappings and credentials without mutating the connection", async () => {
  const original = globalThis.fetch;
  const request = {
    instanceId: 7,
    url: "http://sonarr",
    libraryKeys: ["shows"],
    pathMappings: [{ kind: "library" as const, arrPath: "/tv", localPath: "/media" }],
  };
  globalThis.fetch = (url, init) => {
    assertEquals(url, "/api/integrations/arr/verify-storage");
    assertEquals(init?.method, "POST");
    assertEquals(JSON.parse(String(init?.body)), request);
    return Promise.resolve(Response.json({ status: "unverified", reason: "No sample" }));
  };
  try {
    assertEquals(await api.arr.verifyStorage(request), {
      status: "unverified",
      reason: "No sample",
    });
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("Arr root-folder discovery posts credentials without putting them in the URL", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { input: RequestInfo | URL | null; init?: RequestInit } = { input: null };
  globalThis.fetch = (input, init) => {
    captured.input = input;
    captured.init = init;
    return Promise.resolve(Response.json({ roots: ["/data/TV"] }));
  };
  try {
    assertEquals(
      await api.arr.rootFolders({ type: "sonarr", url: "http://sonarr:8989", apiKey: "secret" }),
      { roots: ["/data/TV"] },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(captured.input, "/api/integrations/arr/root-folders");
  assertEquals(captured.init?.method, "POST");
  assertEquals(JSON.parse(String(captured.init?.body)), {
    type: "sonarr",
    url: "http://sonarr:8989",
    apiKey: "secret",
  });
});

Deno.test("qBittorrent storage discovery uses the connected server endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requested: RequestInfo | URL | null = null;
  globalThis.fetch = (input) => {
    requested = input;
    return Promise.resolve(Response.json({ paths: ["/data/.torrents/complete"] }));
  };
  try {
    assertEquals(await api.qbittorrent.storagePaths(), {
      paths: ["/data/.torrents/complete"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(requested, "/api/integrations/qbittorrent/storage-paths");
});

Deno.test("no-content responses resolve successfully without JSON parsing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 204 }));
  try {
    assertEquals(await api.settings.removeIgnoredContent("show-1"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sync conflicts expose the active sync id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({ error: "sync already in progress", syncId: 42 }, {
      status: 409,
    }));
  try {
    await assertRejects(
      () => api.sync.trigger(),
      ApiError,
      "Sync already in progress",
    ).then((error) => {
      assertEquals(error.status, 409);
      assertEquals(error.syncId, 42);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
