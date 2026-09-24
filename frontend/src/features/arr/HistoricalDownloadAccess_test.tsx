// deno-lint-ignore-file require-await -- React async act flushes effects and microtasks.
/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import TestRenderer, { act } from "react-test-renderer";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  HistoricalCleanupShortcut,
  HistoricalDownloadAccess,
  HistoricalDownloadAccessBanner,
  type HistoricalDownloadAccessHandle,
} from "./HistoricalDownloadAccess.tsx";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import type { HistoricalAccessStatus } from "../../../../shared/historicalDownloads.ts";
import { historicalAccessMessage } from "./historicalAccessNotifications.ts";

Deno.test("verified setup offers Enable without opening a form or enabling on render", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = { ...api.historicalAccess };
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } },
  });
  const proposal: HistoricalAccessStatus = {
    id: "proposal",
    instanceId: 2,
    revision: "verified",
    status: "ready_to_enable",
    configuration: {
      enabled: false,
      noRemainingClient: false,
      remoteRoot: "/remote",
      localRoot: "/downloads",
    },
    sample: "/remote/file",
    reason: null,
    checkedAt: 1,
    succeededAt: null,
    problemRevision: null,
    dismissedRevision: null,
  };
  const data = { serverId: 1, statuses: [proposal] };
  qc.setQueryData(queryKeys.historicalDownloadAccess.all, data);
  api.historicalAccess.get = () => Promise.resolve(data);
  let enabled: unknown[] | undefined;
  let opened = false;
  api.historicalAccess.enable = (...args) => {
    enabled = args;
    return Promise.resolve(undefined);
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={qc}>
          <HistoricalCleanupShortcut
            instanceId={2}
            onOpen={() => {
              opened = true;
            }}
          />
        </QueryClientProvider>,
      );
    });
    assertEquals(enabled, undefined);
    assertEquals(renderer.root.findByType("button").children, ["Enable"]);
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });
    assertEquals(enabled, ["proposal", "verified"]);
    assertEquals(opened, false);
  } finally {
    await act(async () => renderer?.unmount());
    qc.clear();
    Object.assign(api.historicalAccess, original);
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

Deno.test("cleanup shows disconnected service cards and opens the requested service with an unsaved mount suggestion", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = { ...api.historicalAccess };
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  const data = { serverId: 1, statuses: [], suggestedLocalFolders: ["/downloads"] };
  qc.setQueryData(queryKeys.historicalDownloadAccess.all, data);
  api.historicalAccess.get = () => Promise.resolve(data);
  let saves = 0;
  api.historicalAccess.save = () => {
    saves++;
    return Promise.resolve(undefined);
  };

  let connected = "";
  const ref = createRef<HistoricalDownloadAccessHandle>();
  let renderer!: TestRenderer.ReactTestRenderer;
  const render = (instances: Array<{ id: number; name: string; type: string }>) => (
    <QueryClientProvider client={qc}>
      <HistoricalDownloadAccess
        ref={ref}
        instances={instances}
        onConnect={(type) => {
          connected = type;
        }}
      />
    </QueryClientProvider>
  );
  const button = (label: string) =>
    renderer.root.findAllByType("button").find((b) =>
      b.children.filter((c) => typeof c === "string").join("").trim() === label
    )!;
  try {
    await act(async () => {
      renderer = TestRenderer.create(render([]));
    });
    await act(async () => {
      ref.current!.open();
    });
    assertEquals(renderer.root.findAllByType("h4").map((h) => h.children.join("")), [
      "Sonarr",
      "Radarr",
    ]);
    assertEquals(
      renderer.root.findAllByType("span").filter((s) => s.children.includes("Not connected"))
        .length,
      2,
    );
    assertEquals(button("Add folder"), undefined);
    await act(async () => {
      button("Connect Sonarr").props.onClick();
    });
    assertEquals(connected, "sonarr");
    await act(async () => {
      renderer.update(render([
        { id: 1, name: "Sonarr", type: "sonarr" },
        { id: 2, name: "Radarr", type: "radarr" },
      ]));
    });
    await act(async () => {
      ref.current!.open(2);
    });
    assertEquals(renderer.root.findByType("select").props.value, "2");
    assertEquals(renderer.root.findAllByType("input")[0].props.value, "");
    assertEquals(renderer.root.findAllByType("input")[1].props.value, "/downloads");
    assertEquals(renderer.root.findAllByType("input")[2].props.checked, false);
    assertEquals(saves, 0);
  } finally {
    await act(async () => renderer?.unmount());
    qc.clear();
    Object.assign(api.historicalAccess, original);
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

Deno.test("card, manual recheck and global warning share guidance and clear recovered errors", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = { ...api.historicalAccess };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const failure: HistoricalAccessStatus = {
    id: "one",
    instanceId: 1,
    revision: "1",
    configuration: {
      enabled: true,
      remoteRoot: "/remote",
      localRoot: "/downloads",
      noRemainingClient: false,
    },
    status: "access_lost",
    sample: "/remote/old-file",
    reason: null,
    diagnostic: { code: "read_only", folder: "/downloads" },
    checkedAt: 1,
    succeededAt: 1,
    problemRevision: "problem",
    dismissedRevision: null,
  };
  let current = { serverId: 1, statuses: [failure] };
  qc.setQueryData(queryKeys.historicalDownloadAccess.all, current);
  api.historicalAccess.get = () => Promise.resolve(current);
  api.historicalAccess.check = () => {
    current = {
      serverId: 1,
      statuses: [{ ...failure, status: "available", diagnostic: undefined, problemRevision: null }],
    };
    return Promise.resolve(current);
  };
  const ref = createRef<HistoricalDownloadAccessHandle>();
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={qc}>
          <HistoricalDownloadAccess
            ref={ref}
            instances={[{ id: 1, name: "Sonarr", type: "sonarr" }]}
          />
          <HistoricalDownloadAccessBanner />
        </QueryClientProvider>,
      );
      await new Promise((r) => setTimeout(r, 10));
    });
    await act(async () => {
      ref.current!.open();
    });
    const guidance = historicalAccessMessage(failure);
    assertEquals(renderer.root.findAllByType("p").some((p) => p.children.includes(guidance)), true);
    assertEquals(
      renderer.root.findAllByType("span").some((p) => p.children.includes(guidance)),
      true,
    );
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.children.includes("Check access"))!.props
        .onClick();
      await new Promise((r) => setTimeout(r, 20));
    });
    assertEquals(JSON.stringify(renderer.toJSON()).includes("is on a read-only mount"), false);
    assertEquals(
      JSON.stringify(renderer.toJSON()).includes("passed read-only access checks"),
      true,
    );
  } finally {
    await act(async () => renderer?.unmount());
    qc.clear();
    Object.assign(api.historicalAccess, original);
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

Deno.test("setup edits a saved association and suppresses old-server manual check results", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = { ...api.historicalAccess };
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  const status: HistoricalAccessStatus = {
    id: "1:1:/downloads",
    instanceId: 1,
    revision: "one",
    configuration: {
      remoteRoot: "/downloads",
      localRoot: "/existing",
      enabled: true,
      noRemainingClient: true,
    },
    status: "setup_needed",
    sample: "/downloads/file",
    reason: "denied",
    checkedAt: null,
    succeededAt: null,
    problemRevision: "problem",
    dismissedRevision: null,
  };
  let current = { serverId: 1, statuses: [status] };
  api.historicalAccess.get = () => Promise.resolve(current);
  let saved: unknown[] | undefined;
  api.historicalAccess.save = (...args) => {
    saved = args;
    return Promise.resolve(undefined);
  };
  let complete!: (value: { statuses: HistoricalAccessStatus[] }) => void;
  api.historicalAccess.check = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  qc.setQueryData(queryKeys.historicalDownloadAccess.all, current);
  const ref = createRef<HistoricalDownloadAccessHandle>();
  let renderer!: TestRenderer.ReactTestRenderer;
  const button = (label: string) =>
    renderer.root.findAllByType("button").find((b) =>
      b.children.filter((c) => typeof c === "string").join("").trim() === label
    )!;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={qc}>
          <HistoricalDownloadAccess
            ref={ref}
            instances={[{ id: 1, name: "Sonarr", type: "sonarr" }]}
          />
        </QueryClientProvider>,
      );
    });
    assertEquals(renderer.root.findAllByType("dialog").length, 0);
    assertEquals(renderer.root.findAllByType("input").length, 0);
    await act(async () => {
      ref.current!.open();
    });
    assertEquals(renderer.root.findAllByType("dialog").length, 1);
    await act(async () => {
      button("Edit access").props.onClick();
    });
    assertEquals(renderer.root.findByType("select").props.value, "1");
    const inputs = renderer.root.findAllByType("input");
    assertEquals(inputs[0].props.value, "/downloads");
    assertEquals(inputs[1].props.value, "/existing");
    assertEquals(inputs[2].props.checked, true);
    assertEquals(inputs[0].props.disabled, undefined);
    await act(async () => {
      inputs[0].props.onChange({ target: { value: "/completed" } });
    });
    assertEquals(renderer.root.findAllByType("input")[2].props.checked, false);
    await act(async () => {
      renderer.root.findAllByType("form").find((f) => f.props.onSubmit)!.props.onSubmit({
        preventDefault() {},
      });
      await new Promise((r) => setTimeout(r, 5));
    });
    assertEquals(saved, [1, {
      enabled: true,
      remoteRoot: "/completed",
      localRoot: "/existing",
      noRemainingClient: false,
    }, status.id]);
    assertEquals(renderer.root.findAllByType("input").length, 0);
    await act(async () => {
      renderer.root.findByType("dialog").props.onClose({ stopPropagation() {} });
    });
    assertEquals(renderer.root.findAllByType("dialog").length, 0);
    await act(async () => {
      ref.current!.open();
    });
    await act(async () => {
      button("Check access").props.onClick();
    });
    await act(async () => {
      current = { serverId: 2, statuses: [] };
      qc.setQueryData(queryKeys.historicalDownloadAccess.all, current);
      await new Promise((r) => setTimeout(r, 5));
    });
    await act(async () => {
      complete({ statuses: [{ ...status, status: "available" }] });
    });
    assertEquals(renderer.root.findAllByProps({ role: "status" }).length, 0);
    assertEquals(renderer.root.findAllByType("dialog").length, 0);
    assertEquals(renderer.root.findAllByType("input").length, 0);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    qc.clear();
    Object.assign(api.historicalAccess, original);
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
