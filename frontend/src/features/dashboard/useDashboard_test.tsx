/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { useDashboard } from "./useDashboard.ts";

Deno.test("populated dashboard loads before history and removal stats, while sync stays gated", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prior = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const originalFetch = globalThis.fetch;
  const history = Promise.withResolvers<Response>();
  const removals = Promise.withResolvers<Response>();
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  globalThis.fetch = (url) => {
    if (String(url).startsWith("/api/sync/history")) return history.promise;
    if (url === "/api/media-removals/summary") return removals.promise;
    if (String(url).startsWith("/api/libraries?")) {
      return Promise.resolve(Response.json({
        libraries: [{ key: "1", type: "movie", itemCount: 10, syncedAt: 100 }],
      }));
    }
    return Promise.resolve(Response.json({ instances: [] }));
  };
  let state: ReturnType<typeof useDashboard> | undefined;
  function Observer() {
    state = useDashboard();
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <Observer />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertEquals(state?.librariesData?.libraries.length, 1);
    assertEquals(state?.isDashboardLoading, false);
    assertEquals(state?.isAnySyncing, true);
    assertEquals(state?.mediaRemovalSummary, undefined);
    await act(async () => {
      history.resolve(Response.json([]));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertEquals(state?.isAnySyncing, false);
    assertEquals(state?.isDashboardLoading, false);
  } finally {
    await act(() => renderer?.unmount());
    history.resolve(Response.json([]));
    removals.resolve(Response.json({ mediaSizeRemoved: 0 }));
    await client.cancelQueries();
    client.clear();
    globalThis.fetch = originalFetch;
    globals.IS_REACT_ACT_ENVIRONMENT = prior;
  }
});
