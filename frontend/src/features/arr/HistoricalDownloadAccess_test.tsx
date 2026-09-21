// deno-lint-ignore-file require-await -- React async act flushes effects and microtasks.
/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  HistoricalDownloadAccess,
  HistoricalDownloadAccessBanner,
} from "./HistoricalDownloadAccess.tsx";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import type { HistoricalAccessStatus } from "../../../../shared/historicalDownloads.ts";
import { historicalAccessMessage } from "./historicalAccessNotifications.ts";

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
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={qc}>
          <HistoricalDownloadAccess instances={[{ id: 1, name: "Sonarr", type: "sonarr" }]} />
          <HistoricalDownloadAccessBanner />
        </QueryClientProvider>,
      );
      await new Promise((r) => setTimeout(r, 10));
    });
    await act(async () => {
      renderer.root.findAllByType("button").find((b) =>
        b.children.some((c) => typeof c === "string" && c.trim() === "Manage access")
      )!.props
        .onClick();
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
  let renderer!: TestRenderer.ReactTestRenderer;
  const button = (label: string) =>
    renderer.root.findAllByType("button").find((b) =>
      b.children.filter((c) => typeof c === "string").join("").trim() === label
    )!;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={qc}>
          <HistoricalDownloadAccess instances={[{ id: 1, name: "Sonarr", type: "sonarr" }]} />
        </QueryClientProvider>,
      );
    });
    assertEquals(renderer.root.findAllByType("dialog").length, 0);
    assertEquals(renderer.root.findAllByType("input").length, 0);
    await act(async () => {
      button("Manage access").props.onClick();
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
      button("Manage access").props.onClick();
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
