/// <reference lib="dom" />
import { assert, assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { ServiceStorageSetup } from "./ServiceStorageSetup.tsx";
import { api } from "../../lib/api.ts";
import type { ServiceStorageSettings } from "../../../../shared/serviceStorage.ts";

Deno.test("empty-library setup confirms reusable roots without sample media and never labels an untested connection Connected", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const originalGet = api.serviceStorage.get, originalSave = api.serviceStorage.save;
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
  const saved: unknown[] = [];
  api.serviceStorage.get = () => Promise.resolve(data);
  api.serviceStorage.save = (value) => {
    saved.push(value);
    return Promise.resolve({ id: 1 });
  };
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
    assert(JSON.stringify(renderer!.toJSON()).includes("Connection needs attention"));
    assert(!JSON.stringify(renderer!.toJSON()).includes("Connected"));
    assert(JSON.stringify(renderer!.toJSON()).includes("No shared layout could be established"));
    assertEquals(renderer!.root.findAllByType("input").length, 0);
    await act(() =>
      renderer!.root.findByType("details").props.onToggle({ currentTarget: { open: true } })
    );
    await act(() =>
      renderer!.root.findAllByType("button").find((button) =>
        button.children.includes("Add relationship")
      )!.props.onClick()
    );
    const inputs = renderer!.root.findAllByType("input");
    assertEquals(inputs.filter((input) => input.props.type !== "checkbox").length, 2);
    const submit = () =>
      renderer!.root.findAllByType("button").find((button) => button.props.type === "submit")!;
    assertEquals(submit().props.disabled, true);
    await act(() => {
      inputs[0].props.onChange({ target: { value: "/tv" } });
      inputs[1].props.onChange({ target: { value: "/storage/tv" } });
      inputs.at(-1)!.props.onChange({ target: { checked: true } });
    });
    assertEquals(submit().props.disabled, false);
    await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assertEquals(saved, [{
      serviceKey: "plex:tv",
      configurationIdentity: "identity",
      serviceRoot: "/tv",
      storageRoot: "/storage/tv",
      caseSensitive: true,
      hasAliases: false,
      confirmed: true,
    }]);
    data.endpoints[0].connectionTestedAt = Date.now();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["service-storage"] });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert(JSON.stringify(renderer!.toJSON()).includes("Connected"));
  } finally {
    await act(() => renderer?.unmount());
    client.clear();
    api.serviceStorage.get = originalGet;
    api.serviceStorage.save = originalSave;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

for (const fails of [false, true]) {
  Deno.test(`automatic setup uses one grouped confirmation and ${fails ? "preserves pending setup on failure" : "reuses saved readiness"}`, async () => {
    const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    const originalGet = api.serviceStorage.get, originalConfirm = api.serviceStorage.confirm;
    const data: ServiceStorageSettings = {
      endpoints: [
        {
          key: "plex:tv",
          name: "Plex TV",
          libraryKeys: ["tv"],
          roots: ["/data/TV"],
          configurationIdentity: "plex",
          connectionTestedAt: 1,
        },
        {
          key: "arr:1",
          name: "Sonarr",
          libraryKeys: ["tv"],
          roots: ["/data/TV"],
          configurationIdentity: "arr",
          connectionTestedAt: 1,
        },
      ],
      relationships: [],
      automation: {
        status: "confirmation_required",
        unavailableServices: [{
          serviceKey: "arr:offline",
          name: "Offline Radarr",
          reason: "Connection needs attention.",
        }],
        proposal: {
          fingerprint: "current-proposal",
          sharedRoot: "/data",
          serviceNames: ["Plex TV", "Sonarr"],
          relationships: [],
        },
      },
    };
    const confirmations: string[] = [];
    api.serviceStorage.get = () => Promise.resolve(structuredClone(data));
    api.serviceStorage.confirm = (fingerprint) => {
      confirmations.push(fingerprint);
      if (fails) return Promise.reject(new Error("The discovered roots changed."));
      data.automation = {
        status: "ready",
        unavailableServices: data.automation?.unavailableServices,
      };
      return Promise.resolve(structuredClone(data));
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
      const serialized = () => JSON.stringify(renderer!.toJSON());
      assert(serialized().includes("One confirmation"));
      assert(serialized().includes("Plex TV, Sonarr"));
      assert(serialized().includes("Offline Radarr"));
      assert(serialized().includes("deletion is not ready"));
      assertEquals(renderer!.root.findAllByType("input").length, 0);
      assert(!serialized().includes("Add relationship"));
      await act(() =>
        renderer!.root.findAllByType("button").find((button) =>
          button.children.includes("Yes, these services share this storage")
        )!.props.onClick()
      );
      await flush();
      assertEquals(confirmations, ["current-proposal"]);
      if (fails) {
        assert(serialized().includes("Setup was not confirmed"));
        assert(serialized().includes("One confirmation"));
        assert(!serialized().includes("Setup ready"));
        const confirmButton = () =>
          renderer!.root.findAllByType("button").find((button) =>
            button.children.includes("Yes, these services share this storage")
          )!;
        assertEquals(confirmButton().props.disabled, true);
        data.automation!.proposal!.fingerprint = "refreshed-proposal";
        await act(() =>
          renderer!.root.findAllByType("button").find((button) =>
            button.children.includes("Refresh connections")
          )!.props.onClick()
        );
        await flush();
        assertEquals(confirmButton().props.disabled, false);
        await act(() => confirmButton().props.onClick());
        await flush();
        assertEquals(confirmations, ["current-proposal", "refreshed-proposal"]);
      } else {
        assert(serialized().includes("Setup ready"));
        assert(serialized().includes("for the available services"));
        assert(!serialized().includes("One confirmation"));
        await act(async () => {
          await client.invalidateQueries({ queryKey: ["service-storage"] });
        });
        await flush();
        assert(serialized().includes("Setup ready"));
        assertEquals(confirmations.length, 1);
      }
    } finally {
      await act(() => renderer?.unmount());
      client.clear();
      api.serviceStorage.get = originalGet;
      api.serviceStorage.confirm = originalConfirm;
      globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    }
  });
}
