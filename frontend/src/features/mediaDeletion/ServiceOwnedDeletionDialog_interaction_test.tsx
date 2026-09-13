/// <reference lib="dom" />
import { assertEquals, assertMatch } from "@std/assert";
import TestRenderer, { act } from "react-test-renderer";

async function flushAct(run: () => void) {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}
import { api, ApiError } from "../../lib/api.ts";
import { ServiceOwnedDeletionDialog } from "./ServiceOwnedDeletionDialog.tsx";
import { DeletionModalShell } from "./DeletionDialog.tsx";
import type {
  ServiceDeletionChoices,
  ServiceDeletionRequest,
} from "../../../../shared/serviceOwnedDeletion.ts";

Deno.test("service dialog resets optional consent on refresh and selection and retries immutable requests", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  // Ordinary LAN HTTP exposes getRandomValues but not randomUUID.
  const randomUuidDescriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  const oldPreview = api.serviceDeletions.preview, oldCreate = api.serviceDeletions.create;
  const previews: ServiceDeletionChoices[] = [], requests: ServiceDeletionRequest[] = [];
  api.serviceDeletions.preview = (choices) => {
    previews.push(choices);
    return Promise.resolve({
      fingerprint: JSON.stringify(choices),
      arrConfigured: true,
      qbConfigured: true,
      canConfirm: true,
      targets: [],
    });
  };
  api.serviceDeletions.create = (request) => {
    requests.push({ ...request });
    return requests.length === 1
      ? Promise.reject(new Error("lost response"))
      : requests.length === 2
      ? Promise.reject(new ApiError(409, "Retry lookup unavailable"))
      : Promise.resolve({ operationId: "operation", status: "queued", targetCount: 1 });
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const created: string[] = [];
  let cancelled = false;
  let parentLocked = false;
  const render = (ratingKey: string) => (
    <ServiceOwnedDeletionDialog
      dialogRef={{ current: null }}
      libraryKey="tv"
      targets={[{ ratingKey }]}
      quickCleanupThresholdDays={365}
      embedded
      onCreated={(id) => created.push(id)}
      onCancel={() => {
        cancelled = true;
      }}
      onPendingChange={(value) => {
        parentLocked = value;
      }}
    />
  );
  try {
    await flushAct(() => {
      renderer = TestRenderer.create(render("one"));
    });
    const inputs = () => renderer!.root.findAllByType("input");
    const button = (label: string) =>
      renderer!.root.findAllByType("button").find((entry) => entry.children.join("") === label)!;
    assertEquals(inputs().map((entry) => entry.props.checked), [false, false]);
    await flushAct(() => {
      inputs()[0].props.onChange({ target: { checked: true } });
    });
    assertEquals(previews.at(-1)!.arrSelected, true);
    await flushAct(() => {
      button("Refresh").props.onClick();
    });
    assertEquals(inputs().map((entry) => entry.props.checked), [false, false]);
    await flushAct(() => {
      inputs()[1].props.onChange({ target: { checked: true } });
    });
    await flushAct(() => {
      renderer!.update(render("two"));
    });
    assertEquals(inputs().map((entry) => entry.props.checked), [false, false]);
    await flushAct(() => {
      button("Confirm decisions").props.onClick();
    });
    assertEquals(inputs().every((entry) => entry.props.disabled), true);
    assertEquals(button("Cancel").props.disabled, true);
    assertEquals(parentLocked, true);
    const shell = renderer!.root.findByType(DeletionModalShell);
    assertEquals(shell.props.pending, true);
    await flushAct(() => {
      button("Cancel").props.onClick();
      shell.props.onClose();
    });
    assertEquals(cancelled, false);
    await flushAct(() => {
      button("Retry same request").props.onClick();
    });
    assertEquals(requests.length, 2);
    assertEquals(requests[0], requests[1]);
    assertEquals(button("Cancel").props.disabled, true);
    assertEquals(button("Refresh").props.disabled, true);
    assertEquals(created, []);
    await flushAct(() => {
      button("Retry same request").props.onClick();
    });
    assertEquals(requests.length, 3);
    assertEquals(requests[0], requests[2]);
    assertMatch(
      requests[0].clientRequestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assertEquals(requests[0].quickCleanupThresholdDays, 365);
    assertEquals(previews.every((entry) => entry.quickCleanupThresholdDays === 365), true);
    assertEquals(created, ["operation"]);
  } finally {
    await flushAct(() => {
      renderer?.unmount();
    });
    api.serviceDeletions.preview = oldPreview;
    api.serviceDeletions.create = oldCreate;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    if (randomUuidDescriptor) Object.defineProperty(crypto, "randomUUID", randomUuidDescriptor);
    else Reflect.deleteProperty(crypto, "randomUUID");
  }
});

Deno.test("failed preview discards confirmation and a definite rejection requires current review", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const oldPreview = api.serviceDeletions.preview, oldCreate = api.serviceDeletions.create;
  let failRead = false;
  api.serviceDeletions.preview = () =>
    failRead ? Promise.reject(new Error("offline")) : Promise.resolve({
      fingerprint: "current",
      arrConfigured: true,
      qbConfigured: true,
      canConfirm: true,
      targets: [],
    });
  api.serviceDeletions.create = () => Promise.reject(new ApiError(409, "Evidence changed"));
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await flushAct(() => {
      renderer = TestRenderer.create(
        <ServiceOwnedDeletionDialog
          dialogRef={{ current: null }}
          libraryKey="lib"
          targets={[{ ratingKey: "one" }]}
          embedded
          onCreated={() => {}}
          onCancel={() => {}}
        />,
      );
    });
    const button = (label: string) =>
      renderer!.root.findAllByType("button").find((entry) => entry.children.join("") === label)!;
    await flushAct(() => {
      button("Confirm decisions").props.onClick();
    });
    assertEquals(button("Confirm decisions").props.disabled, true);
    assertEquals(button("Refresh").props.disabled, false);
    failRead = true;
    await flushAct(() => {
      button("Refresh").props.onClick();
    });
    assertEquals(button("Confirm decisions").props.disabled, true);
    assertEquals(renderer!.root.findAllByType("input").map((input) => input.props.checked), [
      false,
      false,
    ]);
    failRead = false;
    await flushAct(() => {
      button("Refresh").props.onClick();
    });
    assertEquals(button("Confirm decisions").props.disabled, false);
  } finally {
    await flushAct(() => {
      renderer?.unmount();
    });
    api.serviceDeletions.preview = oldPreview;
    api.serviceDeletions.create = oldCreate;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
