import { assertEquals } from "@std/assert";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queryKeys.ts";
import { invalidateGlobalSyncQueries } from "./syncCacheInvalidation.ts";

function observeLibraries() {
  let requests = 0;
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  client.setQueryData(queryKeys.libraries.all, 0);
  const observer = new QueryObserver(client, {
    queryKey: queryKeys.libraries.all,
    queryFn: () => Promise.resolve(++requests),
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  return {
    client,
    requests: () => requests,
    close: () => {
      unsubscribe();
      client.clear();
    },
  };
}

Deno.test("dashboard and coordinator observing one completion refetch once", async () => {
  const view = observeLibraries();
  try {
    await Promise.all([
      invalidateGlobalSyncQueries(view.client, 10, true),
      invalidateGlobalSyncQueries(view.client, 10, true),
    ]);
    // A delayed history observation after the first fetch finishes must also coalesce.
    await invalidateGlobalSyncQueries(view.client, 10, true);
    assertEquals(view.requests(), 1);
    await invalidateGlobalSyncQueries(view.client, 11, true);
    assertEquals(view.requests(), 2);
  } finally {
    view.close();
  }
});

Deno.test("stream error refresh does not suppress later completion refresh", async () => {
  const view = observeLibraries();
  try {
    await invalidateGlobalSyncQueries(view.client, 12, false);
    await invalidateGlobalSyncQueries(view.client, 12, false);
    assertEquals(view.requests(), 1);
    await invalidateGlobalSyncQueries(view.client, 12, true);
    await invalidateGlobalSyncQueries(view.client, 12, true);
    await invalidateGlobalSyncQueries(view.client, 12, false);
    assertEquals(view.requests(), 2);
  } finally {
    view.close();
  }
});

Deno.test("completion deduplication does not cross QueryClient boundaries", async () => {
  const first = observeLibraries();
  const second = observeLibraries();
  try {
    await invalidateGlobalSyncQueries(first.client, 13, true);
    await invalidateGlobalSyncQueries(second.client, 13, true);
    assertEquals(first.requests(), 1);
    assertEquals(second.requests(), 1);
  } finally {
    first.close();
    second.close();
  }
});
