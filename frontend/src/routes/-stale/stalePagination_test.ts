import { assertEquals, assertThrows } from "@std/assert";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { StaleResponse } from "@shared/types";
import { queryKeys } from "../../lib/queryKeys.ts";
import {
  lastStalePageOffset,
  requireStaleTotal,
  reuseStaleTotal,
  staleScopesMatch,
} from "./stalePagination.ts";

function response(total: number | null): StaleResponse {
  return {
    scope: "show",
    days: 365,
    maxDays: null,
    minAgeDays: 90,
    libraryStaleMinAgeDays: null,
    historySyncedAt: 1,
    search: "",
    filter: "all",
    sort: "fileSize",
    order: "desc",
    duplicatesOnly: false,
    limit: 50,
    offset: 0,
    total,
    hasMore: true,
    items: [],
  };
}

Deno.test("stale pagination requires visible totals and reuses them for prefetches", () => {
  assertEquals(requireStaleTotal(response(120)).total, 120);
  assertThrows(() => requireStaleTotal(response(null)));
  assertEquals(reuseStaleTotal(response(null), 120).total, 120);
  assertEquals(reuseStaleTotal(response(121), 120).total, 121);
});

Deno.test("stale pagination clamps direct links to a valid page boundary", () => {
  assertEquals(lastStalePageOffset(0, 50), 0);
  assertEquals(lastStalePageOffset(1, 50), 0);
  assertEquals(lastStalePageOffset(50, 50), 0);
  assertEquals(lastStalePageOffset(51, 50), 50);
  assertEquals(lastStalePageOffset(120, 50), 100);
});

Deno.test("implicit stale scope matches show responses but never season responses", () => {
  assertEquals(staleScopesMatch("show", undefined), true);
  assertEquals(staleScopesMatch("show", "show"), true);
  assertEquals(staleScopesMatch("season", "season"), true);
  assertEquals(staleScopesMatch("season", undefined), false);
  assertEquals(staleScopesMatch("show", "season"), false);
});

Deno.test("an active stale page refetches with its counted query after uncounted prefetch", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const key = queryKeys.stale.list("movies", { days: 365, offset: 50 });
  await client.prefetchQuery({
    queryKey: key,
    queryFn: () => Promise.resolve(reuseStaleTotal(response(null), 120)),
  });

  let countedFetches = 0;
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: () => {
      countedFetches += 1;
      return Promise.resolve(requireStaleTotal(response(119)));
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await client.invalidateQueries({ queryKey: key });
    assertEquals(countedFetches, 1);
    assertEquals(observer.getCurrentResult().data?.total, 119);
  } finally {
    unsubscribe();
    client.clear();
  }
});
