/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import TestRenderer, { act } from "react-test-renderer";
import { api } from "../../lib/api.ts";
import { ServiceOwnedDeletionDialog } from "./ServiceOwnedDeletionDialog.tsx";
import { DeletionDialogFooter } from "./DeletionDialog.tsx";
import { DestinationOptions } from "./DeletionPlanSummary.tsx";
import type { HistoricalDownloadPreview } from "../../../../shared/historicalDownloads.ts";
import type { ServiceDeletionRequest } from "../../../../shared/serviceOwnedDeletion.ts";

// Flush queued effects and promise updates inside React's asynchronous act boundary.
function settleReact(work: () => void) {
  return act(async () => {
    work();
    await Promise.resolve();
  });
}

const historical: HistoricalDownloadPreview = {
  fingerprint: "historical-fingerprint",
  candidates: [{ id: "one-exact-file", path: "/downloads/episode", size: 10, ownerCount: 2 }],
  skipped: [],
  handled: [{ source: "/downloads/tracked", service: "qb", actionIds: ["job"] }],
};
const preview = {
  fingerprint: "service-fingerprint",
  arrConfigured: true,
  qbConfigured: false,
  canConfirm: true,
  targets: [{
    ratingKey: "season",
    title: "Fixture season",
    decisions: [{
      actionId: "sonarr-file",
      targetId: "file",
      service: "sonarr" as const,
      requested: false,
      state: "kept" as const,
      reason: "Not selected",
      evidenceRevision: "fixture",
      presence: "current" as const,
    }],
  }],
};

Deno.test("history consent binds reviewed candidates; opting out or cancelling verification cannot adopt late results", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = { ...api.serviceDeletions };
  const requests: ServiceDeletionRequest[] = [];
  let resolve!: (p: HistoricalDownloadPreview) => void;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  api.serviceDeletions.preview = () => Promise.resolve(preview);
  api.serviceDeletions.historicalPreview = () =>
    new Promise((r) => {
      resolve = r;
    });
  api.serviceDeletions.create = (request) => {
    requests.push(request);
    return Promise.resolve({ operationId: "fixture", status: "queued", targetCount: 1 });
  };
  const render = (key: string) => (
    <ServiceOwnedDeletionDialog
      key={key}
      libraryKey="fixture"
      targets={[{ ratingKey: "season" }]}
      dialogRef={{ current: null }}
      onCreated={() => {}}
      onCancel={() => {}}
      focusCancel={false}
    />
  );
  const button = (text: string) =>
    renderer!.root.findAllByType("button").find((b) => b.children.join("") === text)!;
  try {
    await settleReact(() => {
      renderer = TestRenderer.create(render("opt-out"));
    });
    await settleReact(() => {
      button("Continue without leftover cleanup").props.onClick();
    });
    assertEquals(requests.length, 1);
    assertEquals(requests[0].historicalCleanup, undefined);
    await settleReact(() => {
      resolve(historical);
    });
    assertEquals(requests.length, 1);
    assertEquals(requests[0].historicalCleanup, undefined);

    await settleReact(() => {
      renderer!.update(render("cancel-only"));
    });
    await settleReact(() => {
      button("Cancel verification").props.onClick();
    });
    await settleReact(() => {
      resolve(historical);
    });
    assertEquals(requests.length, 1);
    assertEquals(
      renderer!.root.findAllByProps({ "aria-label": "Remove history-linked download files" })
        .length,
      0,
    );

    await settleReact(() => {
      renderer!.update(render("consent"));
    });
    await settleReact(() => {
      resolve(historical);
    });
    const checkbox = renderer!.root.findByProps({
      "aria-label": "Remove history-linked download files",
    });
    assertEquals(checkbox.props.checked, false);
    await settleReact(() => {
      checkbox.props.onChange({ target: { checked: true } });
    });
    await settleReact(() => {
      renderer!.root.findByType(DeletionDialogFooter).props.onConfirm();
    });
    assertEquals(requests.length, 2);
    assertEquals(requests[1].historicalCleanup, {
      fingerprint: historical.fingerprint,
      candidateIds: ["one-exact-file"],
    });
    await settleReact(() => {
      renderer!.update(render("new-selection"));
    });
    await settleReact(() => {
      resolve(historical);
    });
    assertEquals(
      renderer!.root.findByProps({ "aria-label": "Remove history-linked download files" }).props
        .checked,
      false,
    );
  } finally {
    await settleReact(() => {
      renderer?.unmount();
    });
    Object.assign(api.serviceDeletions, original);
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

Deno.test("QB coverage refreshes on selection changes and handled paths never gain unlink consent", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = { ...api.serviceDeletions };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const selections: boolean[] = [];
  api.serviceDeletions.preview = (choices) =>
    Promise.resolve({
      ...preview,
      qbConfigured: true,
      targets: [{
        ...preview.targets[0],
        decisions: [...preview.targets[0].decisions, {
          actionId: "job",
          targetId: "job",
          service: "qb",
          presence: "current",
          matchedToSelection: true,
          requested: choices.qbSelected,
          state: choices.qbSelected ? "delete_candidate" : "kept",
          reason: "fixture",
          evidenceRevision: "fixture",
        }],
      }],
    });
  api.serviceDeletions.historicalPreview = (choices) => {
    selections.push(choices.qbSelected);
    return Promise.resolve({
      fingerprint: String(choices.qbSelected),
      candidates: [],
      handled: choices.qbSelected ? historical.handled : [],
      skipped: choices.qbSelected
        ? []
        : [{ source: "/downloads/tracked", reason: "A current download job owns this entry" }],
    });
  };
  api.serviceDeletions.create = () => {
    throw new Error("Review must never submit deletion");
  };
  try {
    await settleReact(() => {
      renderer = TestRenderer.create(
        <ServiceOwnedDeletionDialog
          libraryKey="fixture"
          targets={[{ ratingKey: "season" }]}
          dialogRef={{ current: null }}
          onCreated={() => {}}
          onCancel={() => {}}
          focusCancel={false}
        />,
      );
    });
    const toggle = (checked: boolean) =>
      settleReact(() => {
        renderer!.root.findByType(DestinationOptions).props.options.find((o: { id: string }) =>
          o.id === "cleanup"
        ).onChange(checked);
      });
    await toggle(true);
    const labels = () =>
      renderer!.root.findAllByType("label").map((l) =>
        l.children.filter((c) => typeof c !== "object").join("")
      );
    assertEquals(labels().some((t) => t.includes("1 handled by qBittorrent")), true);
    assertEquals(
      renderer!.root.findAllByProps({ "aria-label": "Remove history-linked download files" })
        .length,
      0,
    );
    await toggle(false);
    assertEquals(labels().some((t) => t.includes("0 handled by qBittorrent")), true);
    assertEquals(selections.at(-1), false);
  } finally {
    await settleReact(() => renderer?.unmount());
    Object.assign(api.serviceDeletions, original);
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
