/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { useEpisodeGapsData } from "./useEpisodeGapsData.ts";
import { episodeGapFixture } from "../fixtures.ts";
import { validateEpisodeGapsSearch } from "../utils/search.ts";

Deno.test("gap rows load and paint before totals; totals failures leave rows usable", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const priorAct = globals.IS_REACT_ACT_ENVIRONMENT;
  const priorFetch = globalThis.fetch;
  const priorFrame = globalThis.requestAnimationFrame;
  const priorCancel = globalThis.cancelAnimationFrame;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  const page = Promise.withResolvers<Response>();
  const summary = Promise.withResolvers<Response>();
  const calls: string[] = [];
  globalThis.fetch = (url) => {
    const path = String(url);
    calls.push(path);
    if (path.startsWith("/api/tools/episode-gaps/summary?")) return summary.promise;
    if (path.startsWith("/api/tools/episode-gaps?")) return page.promise;
    return Promise.resolve(Response.json({ instances: [], mappings: [] }));
  };
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  let state: ReturnType<typeof useEpisodeGapsData> | undefined;
  function Observer() {
    state = useEpisodeGapsData(validateEpisodeGapsSearch({}), false);
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  const paint = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <Observer />
        </QueryClientProvider>,
      );
    });
    assertEquals(calls.some((path) => path.includes("/summary?")), false);
    assertEquals(calls.some((path) => path.includes("includeSummary=false")), true);
    const { summary: _summary, ...rows } = episodeGapFixture;
    page.resolve(Response.json(rows));
    await settle();
    assertEquals(state?.data?.rows.length, rows.rows.length);
    assertEquals(state?.isLoading, false);
    assertEquals(state?.isSummaryLoading, true);
    assertEquals(calls.some((path) => path.includes("/summary?")), false);
    await paint();
    await paint();
    assertEquals(calls.filter((path) => path.includes("/summary?")).length, 1);
    summary.resolve(Response.json({ error: "Totals unavailable" }, { status: 500 }));
    await settle();
    assertEquals(state?.summaryQuery.isError, true);
    assertEquals(state?.isSummaryLoading, false);
    assertEquals(state?.query.isError, false);
    assertEquals(state?.data?.rows.length, rows.rows.length);
  } finally {
    await act(() => renderer?.unmount());
    page.resolve(Response.json({}));
    summary.resolve(Response.json({}));
    await client.cancelQueries();
    client.clear();
    globalThis.fetch = priorFetch;
    globalThis.requestAnimationFrame = priorFrame;
    globalThis.cancelAnimationFrame = priorCancel;
    globals.IS_REACT_ACT_ENVIRONMENT = priorAct;
  }
});
