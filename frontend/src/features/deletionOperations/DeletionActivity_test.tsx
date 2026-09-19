import { assertEquals, assertStringIncludes } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import TestRenderer, { act } from "react-test-renderer";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import type { DeletionActivityItem } from "@shared/types";
import { DeletionActivity } from "./DeletionActivity.tsx";

Deno.test("accepted deletion stays linked after navigation/reload and refreshes through waiting and terminal outcomes", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = api.deletionOperations.activity;
  let operation: DeletionActivityItem = {
    id: "accepted-operation",
    status: "queued",
    targetCount: 42,
    titles: ["The Fresh Prince of Bel-Air"],
    createdAt: 1,
    updatedAt: 1,
    waitingForServiceVerification: false,
  };
  let calls = 0;
  let accepted = false;
  api.deletionOperations.activity = (params) => {
    calls++;
    return Promise.resolve({
      ...params,
      operations: accepted ? [{ ...operation }] : [],
      hasMore: false,
    });
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const clients: QueryClient[] = [];
  const mount = async (client: QueryClient) => {
    const root = createRootRoute({
      component: () => (
        <QueryClientProvider client={client}>
          <DeletionActivity />
        </QueryClientProvider>
      ),
    });
    const detail = createRoute({
      getParentRoute: () => root,
      path: "/deletion-operations/$id",
      component: () => null,
    });
    const router = createRouter({
      routeTree: root.addChildren([detail]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    await act(async () => {
      renderer = TestRenderer.create(
        <RouterContextProvider router={router}>
          <QueryClientProvider client={client}>
            <DeletionActivity />
          </QueryClientProvider>
        </RouterContextProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const check = (status: string) => {
    const text = JSON.stringify(renderer!.toJSON());
    assertStringIncludes(text, "The Fresh Prince of Bel-Air");
    assertStringIncludes(text, status);
    const links = renderer!.root.findAllByType("a");
    assertEquals(links.length, 1);
    assertEquals(links[0].props.href, "/deletion-operations/accepted-operation");
    assertStringIncludes(text, "42");
  };
  try {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    clients.push(client);
    await mount(client);
    assertEquals(renderer!.root.findAllByType("a").length, 0);
    // Acceptance becomes visible on the next list refresh, without any completion event.
    accepted = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.deletionOperations.lists });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    check("Deletion queued");
    // Navigation remount with existing cache must fetch the durable list again.
    await act(() => renderer!.unmount());
    const before = calls;
    await mount(client);
    assertEquals(calls > before, true);
    check("Deletion queued");
    await act(() => renderer!.unmount());
    // Reload drops the entire query cache; the accepted operation remains discoverable.
    const fresh = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    clients.push(fresh);
    await mount(fresh);
    check("Deletion queued");
    for (
      const [status, label] of [
        ["running", "Processing deletion"],
        ["waiting_retry", "Waiting for service verification"],
        ["completed", "Deletion complete"],
        ["completed_with_warning", "Deletion completed with warning"],
        ["needs_attention", "Deletion needs attention"],
        ["cancelled", "Deletion cancelled"],
      ] as const
    ) {
      operation = {
        ...operation,
        status,
        waitingForServiceVerification: status === "waiting_retry",
      };
      await act(async () => {
        await fresh.refetchQueries({ queryKey: queryKeys.deletionOperations.lists });
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      check(label);
    }
    const query =
      fresh.getQueryCache().findAll({ queryKey: queryKeys.deletionOperations.lists })[0];
    assertEquals((query.options as { refetchInterval?: number }).refetchInterval, 5_000);
  } finally {
    await act(() => renderer?.unmount());
    clients.forEach((client) => client.clear());
    api.deletionOperations.activity = original;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
