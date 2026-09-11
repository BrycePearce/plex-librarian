/// <reference lib="dom" />
import { assert, assertEquals } from "@std/assert";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import type { DockerStoragePreview } from "../../../../shared/serviceStorage.ts";
import { api } from "../../lib/api.ts";
import { DockerStorageSetup } from "./DockerStorageSetup.tsx";

Deno.test("Docker report setup imports a file, checks ambiguous matches, requires replacement consent, and invalidates stale results", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const originalPreview = api.serviceStorage.dockerPreview;
  const originalConfirm = api.serviceStorage.dockerConfirm;
  const checks: unknown[] = [];
  const confirmations: unknown[] = [];
  let failSave = true;
  const checked: DockerStoragePreview = {
    status: "confirmation_required",
    fingerprint: "checked-report",
    replacementRequired: true,
    invalidatedServices: [{ serviceKey: "arr:offline", name: "Offline Sonarr" }],
    services: [{
      serviceKey: "plex:2",
      name: "Plex TV",
      containerName: "plex",
      matchedBy: "selection",
      roots: [{ serviceRoot: "/data/TV", storageRoot: "/docker/daemon/mnt/user/TV" }],
    }],
  };
  api.serviceStorage.dockerPreview = (report, selections) => {
    checks.push({ report, selections });
    return Promise.resolve(
      selections?.["plex:2"] === "container-plex" ? checked : {
        status: "unavailable",
        replacementRequired: false,
        services: [{
          serviceKey: "plex:2",
          name: "Plex TV",
          roots: [],
          reason: "The service address could not be matched.",
          candidates: [{ id: "container-plex", name: "plex" }],
        }],
      },
    );
  };
  api.serviceStorage.dockerConfirm = (value) => {
    confirmations.push(value);
    return failSave
      ? Promise.reject(new Error("Connections changed; check again."))
      : Promise.resolve({ endpoints: [], relationships: [], automation: { status: "ready" } });
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
          <DockerStorageSetup />
        </QueryClientProvider>,
      );
    });
    const button = (label: string) =>
      renderer!.root.findAllByType("button").find((item) => item.children.includes(label))!;
    const serialized = () => JSON.stringify(renderer!.toJSON());
    const report = JSON.stringify({ version: 1, host: { daemonId: "fixture" }, containers: [] });
    assertEquals(button("Check report").props.disabled, true);
    await act(() =>
      renderer!.root.findByType("input").props.onChange({
        target: { files: [new File([report], "report.json", { type: "application/json" })] },
      })
    );
    assertEquals(renderer!.root.findByType("textarea").props.value, report);
    await act(() => button("Check report").props.onClick());
    await flush();
    assert(serialized().includes("could not be matched"));
    assert(!serialized().includes("Save checked mappings"));
    await act(() =>
      renderer!.root.findByType("select").props.onChange({ target: { value: "container-plex" } })
    );
    await act(() => button("Check report").props.onClick());
    await flush();
    assertEquals(checks, [{ report, selections: {} }, {
      report,
      selections: { "plex:2": "container-plex" },
    }]);
    assertEquals(button("Save checked mappings").props.disabled, true);
    assert(serialized().includes("Offline Sonarr"));
    assert(serialized().includes("will be removed"));
    assert(serialized().includes("remains unavailable until checked again"));
    assert(serialized().includes("Container selected by you"));
    assert(serialized().includes("/mnt/user/TV"));
    assert(!serialized().includes("/docker/daemon/mnt/user/TV"));
    await act(() =>
      renderer!.root.findAllByType("input").find((item) => item.props.type === "checkbox")!.props
        .onChange({ target: { checked: true } })
    );
    await act(() => button("Save checked mappings").props.onClick());
    await flush();
    assert(serialized().includes("Setup was not saved"));
    assertEquals(button("Save checked mappings").props.disabled, true);
    assertEquals(confirmations, [{
      report,
      fingerprint: "checked-report",
      confirmed: true,
      selections: { "plex:2": "container-plex" },
      replaceExisting: true,
    }]);
    await act(() =>
      renderer!.root.findByType("textarea").props.onChange({ target: { value: report + " " } })
    );
    assert(!serialized().includes("Save checked mappings"));
    assert(!serialized().includes("Setup was not saved"));
    failSave = false;
    await act(() => button("Check report").props.onClick());
    await flush();
    assert(serialized().includes("Choose container"));
    await act(() =>
      renderer!.root.findByType("select").props.onChange({ target: { value: "container-plex" } })
    );
    await act(() => button("Check report").props.onClick());
    await flush();
    await act(() =>
      renderer!.root.findAllByType("input").find((item) => item.props.type === "checkbox")!.props
        .onChange({ target: { checked: true } })
    );
    await act(() => button("Save checked mappings").props.onClick());
    await flush();
    assert(serialized().includes("Reported mappings saved"));
    assertEquals(client.getQueryData(["service-storage"]), {
      endpoints: [],
      relationships: [],
      automation: { status: "ready" },
    });
  } finally {
    await act(() => renderer?.unmount());
    client.clear();
    api.serviceStorage.dockerPreview = originalPreview;
    api.serviceStorage.dockerConfirm = originalConfirm;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

Deno.test("editing an imported Docker report cannot reuse an in-flight preview", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const originalPreview = api.serviceStorage.dockerPreview;
  let resolve!: (value: DockerStoragePreview) => void;
  api.serviceStorage.dockerPreview = () => new Promise((done) => resolve = done);
  const client = new QueryClient();
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <DockerStorageSetup />
        </QueryClientProvider>,
      );
    });
    await act(() =>
      renderer!.root.findByType("textarea").props.onChange({ target: { value: "old" } })
    );
    await act(() =>
      renderer!.root.findAllByType("button").find((item) => item.children.includes("Check report"))!
        .props.onClick()
    );
    await act(() =>
      renderer!.root.findByType("textarea").props.onChange({ target: { value: "new" } })
    );
    await act(async () => {
      resolve({
        status: "confirmation_required",
        fingerprint: "old",
        services: [],
        replacementRequired: false,
      });
      await new Promise((done) => setTimeout(done, 20));
    });
    assert(!JSON.stringify(renderer!.toJSON()).includes("Save checked mappings"));
  } finally {
    await act(() => renderer?.unmount());
    client.clear();
    api.serviceStorage.dockerPreview = originalPreview;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
