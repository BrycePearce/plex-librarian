import { assertEquals } from "@std/assert";
import { api } from "./api.ts";

Deno.test("season cleanup serializes selections as episode media", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { input: RequestInfo | URL | null; init?: RequestInit } = { input: null };
  globalThis.fetch = (input, init) => {
    captured.input = input;
    captured.init = init;
    return Promise.resolve(
      Response.json({ operationIds: ["operation-1"], targetCount: 1 }, { status: 202 }),
    );
  };

  try {
    await api.duplicates.seasonCleanup(
      "request-1",
      [{ ratingKey: "episode-1", deleteMediaIds: [11] }],
      {
        analysisFingerprint: "a".repeat(64),
        expiresAt: 2_000_000_000,
        coordinateSonarr: false,
        cleanupDownloads: false,
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(captured.input, "/api/duplicates/smart-cleanup");
  assertEquals(JSON.parse(String(captured.init?.body)), {
    clientRequestId: "request-1",
    selections: [{
      mediaType: "episode",
      ratingKey: "episode-1",
      deleteMediaIds: [11],
    }],
    includeNearIdentical: true,
    manualSeasonReview: true,
    analysisFingerprint: "a".repeat(64),
    expiresAt: 2_000_000_000,
    coordinateSonarr: false,
    cleanupDownloads: false,
  });
});
