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
