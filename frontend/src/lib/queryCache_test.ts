import { assertEquals } from "@std/assert";
import { QueryClient } from "@tanstack/react-query";
import {
  clearServerScopedQueries,
  invalidateSyncDerivedQueries,
  resetServerScopedQueries,
} from "./queryCache.ts";
import { queryKeys } from "./queryKeys.ts";

Deno.test(
  "sync completion invalidates derived data without touching auth",
  async () => {
    const queryClient = new QueryClient();
    const staleKey = queryKeys.stale.list("2", { days: 365 });
    const previewKey = queryKeys.downloadCleanupPreview.forItems("2", ["42"]);

    queryClient.setQueryData(staleKey, { items: [] });
    queryClient.setQueryData(previewKey, { items: [] });
    queryClient.setQueryData(queryKeys.auth.status, { configured: true });

    await invalidateSyncDerivedQueries(queryClient);

    assertEquals(queryClient.getQueryState(staleKey)?.isInvalidated, true);
    assertEquals(queryClient.getQueryState(previewKey)?.isInvalidated, true);
    assertEquals(
      queryClient.getQueryState(queryKeys.auth.status)?.isInvalidated,
      false,
    );
  },
);

Deno.test("server switch resets every server-scoped detail cache", async () => {
  const queryClient = new QueryClient();
  const movieKey = queryKeys.movie.detail("1", "42");
  const previewKey = queryKeys.downloadCleanupPreview.forItems("1", ["42"]);

  queryClient.setQueryData(movieKey, { movie: { title: "Old server" } });
  queryClient.setQueryData(previewKey, { items: [{ title: "Old server" }] });
  queryClient.setQueryData(queryKeys.auth.status, { configured: true });

  await resetServerScopedQueries(queryClient);

  assertEquals(queryClient.getQueryData(movieKey), undefined);
  assertEquals(queryClient.getQueryData(previewKey), undefined);
  assertEquals(queryClient.getQueryData(queryKeys.auth.status), {
    configured: true,
  });
});

Deno.test("disconnect clears server data without clearing auth status", async () => {
  const queryClient = new QueryClient();
  const libraryKey = queryKeys.libraries.all;

  queryClient.setQueryData(libraryKey, { libraries: [{ title: "Movies" }] });
  queryClient.setQueryData(queryKeys.auth.status, {
    configured: false,
    source: null,
  });

  await clearServerScopedQueries(queryClient);

  assertEquals(queryClient.getQueryData(libraryKey), undefined);
  assertEquals(queryClient.getQueryData(queryKeys.auth.status), {
    configured: false,
    source: null,
  });
});
