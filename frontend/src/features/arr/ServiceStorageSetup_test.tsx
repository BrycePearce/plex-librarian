/// <reference lib="dom" />
import { assert, assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { discoveryRefreshInterval, ServiceStorageSetup } from "./ServiceStorageSetup.tsx";
import { QbittorrentConnections } from "../qbittorrent/QbittorrentConnections.tsx";
import { api } from "../../lib/api.ts";
import type { ServiceStorageSettings } from "../../../../shared/serviceStorage.ts";

Deno.test("discovery status keeps refreshing through ready, failure and recovery until disabled", () => {
  const status: NonNullable<ServiceStorageSettings["discovery"]> = {
    enabled: true,
    checking: false,
    services: [{ serviceKey: "arr:1", name: "Sonarr", connected: true, state: "ready" }],
  };
  // A ready page must observe later host changes without focus or a manual retry.
  assertEquals(discoveryRefreshInterval(status), 30_000);
  status.checking = true;
  assertEquals(discoveryRefreshInterval(status), 2000);
  status.checking = false;
  status.reason = "Host helper unavailable";
  status.services[0].state = "needs_attention";
  assertEquals(discoveryRefreshInterval(status), 30_000);
  delete status.reason;
  status.services[0].state = "ready";
  assertEquals(discoveryRefreshInterval(status), 30_000);
  status.enabled = false;
  assertEquals(discoveryRefreshInterval(status), false);
  assertEquals(discoveryRefreshInterval(undefined), false);
});

Deno.test("automatic setup has no manual editor even in details and never labels an untested connection Connected", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const originalGet = api.serviceStorage.get;
  const data: ServiceStorageSettings = {
    endpoints: [{
      key: "plex:tv",
      name: "Empty TV library",
      configurationIdentity: "identity",
      libraryKeys: ["tv"],
      roots: [],
    }],
    relationships: [],
    automation: {
      status: "unavailable",
      reason: "No shared layout could be established for Empty TV library.",
    },
  };
  api.serviceStorage.get = () => Promise.resolve(structuredClone(data));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <ServiceStorageSetup />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert(JSON.stringify(renderer!.toJSON()).includes("Connection not tested"));
    assert(!JSON.stringify(renderer!.toJSON()).includes("Connected"));
    assert(JSON.stringify(renderer!.toJSON()).includes("Enable host discovery"));
    assertEquals(
      renderer!.root.findAllByType("input").filter((input) => input.props.type !== "file").length,
      0,
    );
    await act(() =>
      renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: true } })
    );
    assert(JSON.stringify(renderer!.toJSON()).includes("Existing saved mappings are preserved"));
    assert(!JSON.stringify(renderer!.toJSON()).includes("Add relationship"));
    assertEquals(renderer!.root.findAllByType("input").length, 0);
    data.endpoints[0].connectionTestedAt = Date.now();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["service-storage"] });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert(JSON.stringify(renderer!.toJSON()).includes("Connected"));
    data.discovery = {
      enabled: true,
      checking: false,
      services: [{
        serviceKey: "plex:tv",
        name: "Empty TV library",
        connected: false,
        state: "needs_attention",
      }],
    };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["service-storage"] });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert(!JSON.stringify(renderer!.toJSON()).includes("Connected"));
    assert(JSON.stringify(renderer!.toJSON()).includes("Connection not tested"));
  } finally {
    await act(() => renderer?.unmount());
    client.clear();
    api.serviceStorage.get = originalGet;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

for (const fails of [false, true]) {
  Deno.test(`host discovery enable ${fails ? "shows a useful error" : "shows separate per-service readiness"} without a setup wall or deletion consent`, async () => {
    const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = globals.IS_REACT_ACT_ENVIRONMENT;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    const originalGet = api.serviceStorage.get, originalAction = api.serviceStorage.discovery;
    const data: ServiceStorageSettings = {
      endpoints: ["plex:tv", "arr:1"].map((key) => ({
        key,
        name: key === "arr:1" ? "Sonarr" : "Plex TV",
        configurationIdentity: key,
        libraryKeys: ["tv"],
        roots: [],
      })),
      relationships: [],
      discovery: { enabled: false, checking: false, services: [] },
    };
    const calls: string[] = [];
    api.serviceStorage.get = () => Promise.resolve(structuredClone(data));
    api.serviceStorage.discovery = (action) => {
      calls.push(action);
      if (fails) {
        return Promise.reject(new Error("Check the helper installation and shared directory."));
      }
      data.discovery = {
        enabled: true,
        checking: false,
        services: [
          { serviceKey: "plex:tv", name: "Plex TV", connected: true, state: "ready" },
          {
            serviceKey: "arr:1",
            name: "Sonarr",
            connected: true,
            state: "needs_attention",
            reason: "Ambiguous container ownership.",
          },
        ],
      };
      return Promise.resolve(data.discovery);
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    const flush = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    try {
      await act(() => {
        renderer = TestRenderer.create(
          <QueryClientProvider client={client}>
            <ServiceStorageSetup />
          </QueryClientProvider>,
        );
      });
      await flush();
      const text = () => JSON.stringify(renderer!.toJSON());
      assert(text().includes("Enable host discovery"));
      assert(text().includes("Not enabled"));
      assert(!text().includes("Needs attention"));
      assert(!text().includes("report field"));
      assert(!text().includes("One confirmation"));
      assertEquals(renderer!.root.findAllByType("input").length, 0);
      await act(() =>
        renderer!.root.findAllByType("button").find((button) =>
          button.children.includes("Enable host discovery")
        )!.props.onClick()
      );
      await flush();
      assertEquals(calls, ["enable"]);
      if (fails) {
        assert(text().includes("Discovery could not be enabled"));
        assert(text().includes("installation guide above"));
        assert(!text().includes("Check the helper installation and shared directory."));
        assert(text().includes("Enable host discovery"));
        await act(() =>
          renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: true } })
        );
        assert(text().includes("Check the helper installation and shared directory."));
      } else {
        assert(text().includes("Connected"));
        assert(text().includes("Ready"));
        assert(text().includes("Needs attention"));
        assert(!text().includes("Setup ready"));
        assert(!text().includes("Ambiguous container ownership"));
        await act(() =>
          renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: true } })
        );
        assert(text().includes("Ambiguous container ownership"));
      }
      assertEquals(renderer!.root.findAllByType("input").length, 0);
      assert(text().includes("unchecked when deleting"));
    } finally {
      await act(() => renderer?.unmount());
      client.clear();
      api.serviceStorage.get = originalGet;
      api.serviceStorage.discovery = originalAction;
      globals.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });
}

Deno.test("successful explicit QB test refreshes mounted discovery status without another Retry", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = {
    storage: api.serviceStorage.get,
    qb: api.qbittorrent.get,
    test: api.qbittorrent.testInstance,
    compatibility: api.integrationCompatibility.get,
  };
  let ready = false, reads = 0;
  api.serviceStorage.get = () => {
    reads++;
    return Promise.resolve({
      endpoints: [{
        key: "qb:db:1",
        name: "QB",
        configurationIdentity: "fixture",
        roots: [],
        libraryKeys: [],
      }],
      relationships: [],
      discovery: {
        enabled: true,
        checking: false,
        services: [{
          serviceKey: "qb:db:1",
          name: "QB",
          connected: true,
          state: ready ? "ready" : "needs_attention",
        }],
      },
    });
  };
  api.qbittorrent.get = () =>
    Promise.resolve({
      envConfigured: false,
      instances: [{
        id: 1,
        name: "QB",
        url: "http://fixture.invalid",
        usernameConfigured: true,
        passwordConfigured: true,
      }],
      targets: [],
      pathMappings: [],
    });
  api.integrationCompatibility.get = () => Promise.resolve({ checkedAt: 1, checks: [] });
  api.qbittorrent.testInstance = () => {
    ready = true;
    return Promise.resolve({
      key: "qb:1",
      instanceId: 1,
      kind: "qbittorrent",
      name: "QB",
      version: "5.0",
      apiVersion: "2.11",
      status: "compatible",
      message: null,
    });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <ServiceStorageSetup />
          <QbittorrentConnections onConfigure={() => {}} onRemove={() => {}} />
        </QueryClientProvider>,
      );
    });
    await flush();
    assert(JSON.stringify(renderer!.toJSON()).includes("Needs attention"));
    await act(() =>
      renderer!.root.findAllByType("button").find((b) => b.children.includes("Test"))!.props
        .onClick()
    );
    await flush();
    assert(reads >= 2);
    assert(JSON.stringify(renderer!.toJSON()).includes("Ready"));
    assert(!JSON.stringify(renderer!.toJSON()).includes("Needs attention"));
    assert(JSON.stringify(renderer!.toJSON()).includes("Discovery refreshes automatically"));
    assert(!JSON.stringify(renderer!.toJSON()).includes("Retry discovery"));
    await act(() =>
      renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: true } })
    );
    assert(JSON.stringify(renderer!.toJSON()).includes("Retry discovery"));
  } finally {
    await act(() => renderer?.unmount());
    client.clear();
    api.serviceStorage.get = original.storage;
    api.qbittorrent.get = original.qb;
    api.qbittorrent.testInstance = original.test;
    api.integrationCompatibility.get = original.compatibility;
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

Deno.test("saved mappings remain untouched until explicit confirmed removal and can be backed up", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const originalGet = api.serviceStorage.get, originalRemove = api.serviceStorage.remove;
  const data: ServiceStorageSettings = {
    endpoints: [{
      key: "arr:1",
      name: "Sonarr",
      configurationIdentity: "fixture",
      roots: [],
      libraryKeys: [],
    }],
    relationships: [{
      id: 8,
      serverId: 1,
      serviceKey: "arr:1",
      configurationIdentity: "fixture",
      serviceRoot: "/custom-tv",
      storageRoot: "/old-tv",
      caseSensitive: true,
      hasAliases: false,
      revision: 3,
    }],
  };
  const removed: number[] = [];
  api.serviceStorage.get = () => Promise.resolve(structuredClone(data));
  api.serviceStorage.remove = (id) => {
    removed.push(id);
    data.relationships = [];
    return Promise.resolve({ ok: true });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const button = (label: string) =>
    renderer!.root.findAllByType("button").find((item) => item.children.includes(label))!;
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <ServiceStorageSetup />
        </QueryClientProvider>,
      );
    });
    await flush();
    await act(() =>
      renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: true } })
    );
    const backup = renderer!.root.findAllByType("a").find((item) => item.props.download)!;
    assertEquals(
      JSON.parse(decodeURIComponent(backup.props.href.split(",").slice(1).join(","))),
      data.relationships,
    );
    assertEquals(removed, []);
    assert(!JSON.stringify(renderer!.toJSON()).includes("Add relationship"));
    await act(() => button("Remove mapping").props.onClick());
    assertEquals(removed, []);
    assert(JSON.stringify(renderer!.toJSON()).includes("does not delete"));
    await act(() => button("Cancel").props.onClick());
    assertEquals(removed, []);
    await act(() => button("Remove mapping").props.onClick());
    await act(() => button("Confirm remove mapping").props.onClick());
    await flush();
    assertEquals(removed, [8]);
    assert(!JSON.stringify(renderer!.toJSON()).includes("/custom-tv"));
  } finally {
    await act(() => renderer?.unmount());
    client.clear();
    api.serviceStorage.get = originalGet;
    api.serviceStorage.remove = originalRemove;
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
