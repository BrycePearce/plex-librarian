import { assertEquals, assertRejects } from "@std/assert";
import { api, ApiError } from "./api.ts";

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
