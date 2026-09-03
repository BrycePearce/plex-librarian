import { assertEquals, assertRejects } from "@std/assert";
import { api, ApiError } from "./api.ts";

Deno.test("whole-item deletion serializes independent Arr and qBittorrent selections", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json({ operationId: "operation-1", status: "queued" }, {
      status: 202,
    }));
  };
  try {
    await api.libraries.deleteItems(
      "movies",
      ["arr-only", "qbit-only"],
      ["arr-only"],
      ["qbit-only"],
      { "qbit-only": "a".repeat(64) },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(body.ratingKeys, ["arr-only", "qbit-only"]);
  assertEquals(body.coordinatedRatingKeys, ["arr-only"]);
  assertEquals(body.cleanupDownloadRatingKeys, ["qbit-only"]);
  assertEquals(body.cleanupPreviewFingerprints, { "qbit-only": "a".repeat(64) });
  assertEquals(Object.hasOwn(body, "cleanupDownloads"), false);
});

Deno.test("movie version deletion serializes explicit Plex-only intent", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { input: RequestInfo | URL | null; init?: RequestInit } = { input: null };
  globalThis.fetch = (input, init) => {
    captured.input = input;
    captured.init = init;
    return Promise.resolve(Response.json({ operationId: "operation-1", status: "queued" }, {
      status: 202,
    }));
  };

  try {
    await api.duplicates.deleteMovieMediaVersions("movie-1", [11], [], {
      radarrMode: "none",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(captured.input, "/api/duplicates/movies/movie-1/media");
  const body = JSON.parse(String(captured.init?.body));
  assertEquals(body.mediaIds, [11]);
  assertEquals(body.cleanupMediaIds, []);
  assertEquals(body.radarrMode, "none");
  assertEquals(typeof body.clientRequestId, "string");
});

Deno.test("season cleanup serializes selections as episode media", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { input: RequestInfo | URL | null; init?: RequestInit } = { input: null };
  globalThis.fetch = (input, init) => {
    captured.input = input;
    captured.init = init;
    return Promise.resolve(
      Response.json({ operationId: "operation-1", status: "queued", targetCount: 1 }, {
        status: 202,
      }),
    );
  };

  try {
    const options = {
      previewFingerprint: "a".repeat(64),
      sonarrMode: "none" as const,
      cleanupDownloads: false,
      // A structurally compatible caller may carry its own selection model. The API
      // boundary must never let extra properties replace the canonical wire selection.
      selections: [{ ratingKey: "legacy-episode", deleteMediaIds: [99] }],
    };
    await api.duplicates.seasonCleanup(
      "season-1",
      "request-1",
      [{ episodeRatingKey: "episode-1", mediaIds: [11] }],
      options,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(captured.input, "/api/duplicates/seasons/season-1/cleanup");
  assertEquals(JSON.parse(String(captured.init?.body)), {
    clientRequestId: "request-1",
    selections: [{
      episodeRatingKey: "episode-1",
      mediaIds: [11],
    }],
    previewFingerprint: "a".repeat(64),
    sonarrMode: "none",
    cleanupDownloads: false,
  });
});

Deno.test("stale season removal binds its accepted preview and destinations", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { input: RequestInfo | URL | null; init?: RequestInit } = { input: null };
  globalThis.fetch = (input, init) => {
    captured.input = input;
    captured.init = init;
    return Promise.resolve(
      Response.json({ operationId: "operation-1", status: "queued", targetCount: 1 }, {
        status: 202,
      }),
    );
  };

  try {
    await api.libraries.deleteSeason("tv library", "season/1", {
      previewFingerprint: "a".repeat(64),
      coordinated: true,
      cleanupDownloads: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(
    captured.input,
    "/api/libraries/tv%20library/seasons/season%2F1/deletion",
  );
  const body = JSON.parse(String(captured.init?.body));
  assertEquals(body.previewFingerprint, "a".repeat(64));
  assertEquals(body.coordinated, true);
  assertEquals(body.cleanupDownloads, false);
  assertEquals(typeof body.clientRequestId, "string");
});

Deno.test("stale season removal exposes a rebuilt preview for reconfirmation", async () => {
  const originalFetch = globalThis.fetch;
  const preview = {
    fingerprint: "b".repeat(64),
    expiresAt: 1234,
    libraryKey: "shows",
    seasonRatingKey: "season-1",
    showRatingKey: "show-1",
    showTitle: "Example Show",
    seasonTitle: "Season 1",
    seasonIndex: 1,
    episodeCount: 10,
    fileSize: 1024,
    coordinatedConfigured: true,
    sonarrStatus: "resolved" as const,
    managedEpisodeCount: 10,
    monitoredEpisodeCount: 10,
    managedFileCount: 10,
    sonarrActionAvailable: true,
    plexFiles: [{ path: "/shows/Example/Season 01/S01E01.mkv", size: 1024 }],
    sonarrFiles: [{
      instanceName: "Sonarr",
      path: "/shows/Example/Season 01/S01E01.mkv",
      size: 1024,
    }],
    cleanupConfigured: false,
    cleanupStatus: "unavailable" as const,
    downloadJobs: [],
    blockers: [],
  };
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      error: "season deletion preview changed",
      code: "PREVIEW_CHANGED",
      preview,
    }, { status: 409 }));
  try {
    await assertRejects(
      () =>
        api.libraries.deleteSeason("shows", "season-1", {
          previewFingerprint: "a".repeat(64),
          coordinated: true,
          cleanupDownloads: false,
        }),
      ApiError,
      "preview changed",
    ).then((error) => {
      assertEquals(error.code, "PREVIEW_CHANGED");
      assertEquals(error.preview, preview);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("season cleanup exposes rebuilt previews for explicit reconfirmation", async () => {
  const originalFetch = globalThis.fetch;
  const preview = { seasonRatingKey: "season-1", fingerprint: "b".repeat(64) };
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      error: "the authoritative season deletion preview changed",
      code: "PREVIEW_CHANGED",
      preview,
    }, { status: 409 }));
  try {
    await assertRejects(
      () =>
        api.duplicates.seasonCleanup(
          "season-1",
          "request-1",
          [{ episodeRatingKey: "episode-1", mediaIds: [11] }],
          {
            previewFingerprint: "a".repeat(64),
            sonarrMode: "none",
            cleanupDownloads: false,
          },
        ),
      ApiError,
      "preview changed",
    ).then((error) => {
      assertEquals(error.code, "PREVIEW_CHANGED");
      assertEquals(error.preview, preview);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
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
