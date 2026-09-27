import { assertEquals } from "@std/assert";
import { QueryClient } from "@tanstack/react-query";
import {
  clearServerScopedQueries,
  invalidateSyncDerivedQueries,
  resetServerScopedQueries,
} from "./queryCache.ts";
import { queryKeys } from "./queryKeys.ts";

const serviceVersionKeys = [
  queryKeys.duplicates.seasonSelectionAnalysis("season", ["episode"]),
  queryKeys.duplicates.technicalRefresh("episode", "episode"),
];

Deno.test(
  "sync completion invalidates derived data without touching auth",
  async () => {
    const queryClient = new QueryClient();
    const staleKey = queryKeys.stale.list("2", { days: 365 });
    const showKey = queryKeys.show.detail("2", "42");
    const movieKey = queryKeys.movie.detail("1", "movie");

    queryClient.setQueryData(staleKey, { items: [] });
    queryClient.setQueryData(showKey, { show: { title: "Show" } });
    queryClient.setQueryData(movieKey, { movie: { title: "Movie" } });
    for (const key of serviceVersionKeys) queryClient.setQueryData(key, { versions: [] });
    queryClient.setQueryData(queryKeys.auth.status, { configured: true });

    await invalidateSyncDerivedQueries(queryClient);

    assertEquals(queryClient.getQueryState(staleKey)?.isInvalidated, true);
    assertEquals(queryClient.getQueryState(showKey)?.isInvalidated, true);
    assertEquals(queryClient.getQueryState(movieKey)?.isInvalidated, true);
    for (const key of serviceVersionKeys) {
      assertEquals(queryClient.getQueryState(key)?.isInvalidated, true);
    }
    assertEquals(
      queryClient.getQueryState(queryKeys.auth.status)?.isInvalidated,
      false,
    );
  },
);

Deno.test("server switch resets every server-scoped detail cache", async () => {
  const queryClient = new QueryClient();
  const movieKey = queryKeys.movie.detail("1", "42");
  const showKey = queryKeys.show.detail("2", "show");

  queryClient.setQueryData(movieKey, { movie: { title: "Old server" } });
  queryClient.setQueryData(queryKeys.historicalDownloadAccess.all, {
    statuses: [{ reason: "Old server root" }],
  });
  queryClient.setQueryData(showKey, { show: { title: "Old server" } });
  for (const key of serviceVersionKeys) queryClient.setQueryData(key, { versions: ["Old server"] });
  queryClient.setQueryData(queryKeys.auth.status, { configured: true });

  await resetServerScopedQueries(queryClient);

  assertEquals(queryClient.getQueryData(movieKey), undefined);
  assertEquals(queryClient.getQueryData(queryKeys.historicalDownloadAccess.all), undefined);
  assertEquals(queryClient.getQueryData(showKey), undefined);
  for (const key of serviceVersionKeys) assertEquals(queryClient.getQueryData(key), undefined);
  assertEquals(queryClient.getQueryData(queryKeys.auth.status), {
    configured: true,
  });
});

Deno.test("disconnect clears server data without clearing auth status", async () => {
  const queryClient = new QueryClient();
  const libraryKey = queryKeys.libraries.all;

  queryClient.setQueryData(libraryKey, { libraries: [{ title: "Movies" }] });
  for (const key of serviceVersionKeys) queryClient.setQueryData(key, { versions: ["Old server"] });
  queryClient.setQueryData(queryKeys.auth.status, {
    configured: false,
    source: null,
  });

  await clearServerScopedQueries(queryClient);

  assertEquals(queryClient.getQueryData(libraryKey), undefined);
  for (const key of serviceVersionKeys) assertEquals(queryClient.getQueryState(key), undefined);
  assertEquals(queryClient.getQueryData(queryKeys.auth.status), {
    configured: false,
    source: null,
  });
});
