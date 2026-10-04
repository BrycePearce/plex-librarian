import { assertEquals, assertRejects } from "@std/assert";
import { QueryClient } from "@tanstack/react-query";
import { requireAuth } from "./requireAuth.ts";
import { queryKeys } from "./queryKeys.ts";

Deno.test("route guards use local configuration even while account validation is pending", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (url) => {
    requests.push(String(url));
    return Promise.resolve(Response.json({ configured: true, source: "db" }));
  };
  // A profile request must neither block nor share incomplete data with the guard.
  const profile = client.fetchQuery({
    queryKey: queryKeys.auth.status,
    queryFn: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
  }).catch(() => {});
  try {
    await requireAuth(client);
    await requireAuth(client);
    assertEquals(requests, ["/api/auth/status?validate=false"]);
    assertEquals(client.getQueryState(queryKeys.auth.status)?.fetchStatus, "fetching");
    client.invalidateQueries({ queryKey: queryKeys.auth.configuration });
    await requireAuth(client);
    assertEquals(requests.length, 2);
  } finally {
    await client.cancelQueries();
    await profile;
    client.clear();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unconfigured route guards redirect to setup", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json({ configured: false, source: null }));
  try {
    const error = await assertRejects(() => requireAuth(client));
    assertEquals((error as unknown as { options: { to: string } }).options.to, "/setup");
  } finally {
    client.clear();
    globalThis.fetch = originalFetch;
  }
});
