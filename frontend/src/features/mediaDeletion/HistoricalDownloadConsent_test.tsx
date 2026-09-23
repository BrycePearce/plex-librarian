/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import TestRenderer, { act } from "react-test-renderer";
import { api } from "../../lib/api.ts";
import { ServiceOwnedDeletionDialog } from "./ServiceOwnedDeletionDialog.tsx";
import { DeletionDialogFooter } from "./DeletionDialog.tsx";
import {
  ServiceDeletionFileTree,
  ServiceDeletionPreviewList,
} from "./ServiceDeletionPreviewList.tsx";
import { ActiveServiceMark, PathTreeRoot } from "./DeletionTree.tsx";
import { BasicDeletionRow, DeletionPreview } from "./DeletionDialog.tsx";
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
  candidates: [{
    id: "one-exact-file",
    path: "/downloads/episode",
    size: 10,
    ownerCount: 2,
    actionIds: ["sonarr-file"],
  }],
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
    files: [{
      path: "/tv/episode.mkv",
      size: 10,
      service: "sonarr" as const,
      actionId: "sonarr-file",
    }],
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

Deno.test("Radarr checkbox automatically includes reviewed historical scope with one discovery", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = { ...api.serviceDeletions };
  let reads = 0;
  const requests: ServiceDeletionRequest[] = [];
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  api.serviceDeletions.preview = () => {
    reads++;
    return Promise.resolve({
      ...preview,
      discovery: true,
      consentToken: "movie-scope",
      historical,
      targets: [{
        ...preview.targets[0],
        ratingKey: "movie",
        title: "Fixture movie",
        files: preview.targets[0].files.map((f) => ({ ...f, service: "radarr" as const })),
        decisions: preview.targets[0].decisions.map((d) => ({ ...d, service: "radarr" as const })),
      }],
    });
  };
  api.serviceDeletions.historicalPreview = () => {
    throw new Error("Retired endpoint");
  };
  api.serviceDeletions.create = (request) => {
    requests.push(request);
    return Promise.resolve({ operationId: "movie", status: "queued", targetCount: 1 });
  };
  try {
    await settleReact(() => {
      renderer = TestRenderer.create(
        <ServiceOwnedDeletionDialog
          libraryKey="movies"
          targets={[{ ratingKey: "movie" }]}
          dialogRef={{ current: null }}
          onCreated={() => {}}
          onCancel={() => {}}
          focusCancel={false}
        />,
      );
    });
    const option = () =>
      renderer!.root.findByType(DestinationOptions).props.options.find((o: { id: string }) =>
        o.id === "arr"
      );
    assertEquals(option().label, "Delete from Radarr");
    await settleReact(() => option().onChange(true));
    assertEquals(
      renderer!.root.findAllByType(ActiveServiceMark).some((m) =>
        m.props.label === "Radarr + historical downloads"
      ),
      true,
    );
    assertEquals(
      renderer!.root.findByType(ServiceDeletionPreviewList).props.historical.candidates[0].id,
      "one-exact-file",
    );
    await settleReact(() => option().onChange(false));
    assertEquals(renderer!.root.findByType(ServiceDeletionPreviewList).props.historical, undefined);
    await settleReact(() => option().onChange(true));
    await settleReact(() => renderer!.root.findByType(DeletionDialogFooter).props.onConfirm());
    assertEquals(requests[0].historicalCleanup?.candidateIds, ["one-exact-file"]);
    assertEquals(reads, 1);
  } finally {
    await settleReact(() => renderer?.unmount());
    Object.assign(api.serviceDeletions, original);
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

Deno.test("one discovery supplies Basic and Advanced paths; Sonarr selection includes history and deselection excludes it", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const original = { ...api.serviceDeletions };
  const requests: ServiceDeletionRequest[] = [];
  let historyReads = 0;
  let previewReads = 0;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  api.serviceDeletions.preview = () => {
    previewReads++;
    return Promise.resolve({
      ...preview,
      discovery: true,
      consentToken: "bound-scope",
      historical,
    });
  };
  api.serviceDeletions.historicalPreview = () => {
    historyReads++;
    throw new Error("Modal must not verify history");
  };
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
  const toggleSonarr = (checked: boolean) =>
    settleReact(() => {
      renderer!.root.findByType(DestinationOptions).props.options.find((o: { id: string }) =>
        o.id === "arr"
      ).onChange(checked);
    });
  try {
    await settleReact(() => {
      renderer = TestRenderer.create(render("opt-out"));
    });
    assertEquals(historyReads, 0);
    await settleReact(() => {
      renderer!.root.findByType(DeletionDialogFooter).props.onConfirm();
    });
    assertEquals(requests.length, 1);
    assertEquals(requests[0].historicalCleanup, undefined);

    assertEquals(requests.length, 1);
    assertEquals(requests[0].historicalCleanup, undefined);

    await settleReact(() => {
      renderer!.update(render("consent"));
    });
    await toggleSonarr(true);

    assertEquals(
      renderer!.root.findAllByType(ActiveServiceMark).filter((mark) => mark.props.historical).map((
        mark,
      ) => mark.props.label),
      ["Sonarr + historical downloads"],
    );

    assertEquals(
      renderer!.root.findAllByProps({ "aria-label": "Remove history-linked download files" })
        .length,
      0,
    );
    assertEquals(
      renderer!.root.findByType(ServiceDeletionPreviewList).props.historical,
      historical,
    );
    assertEquals(
      renderer!.root.findAllByType(BasicDeletionRow).map((row) => row.props.title),
      ["Fixture season"],
    );
    await settleReact(() => {
      renderer!.root.findByType(DeletionPreview).props.onModeChange("advanced");
    });
    const tree = renderer!.root.findByType(ServiceDeletionFileTree);
    const downloadRoots = tree.findAllByType(PathTreeRoot).filter((root) =>
      root.props.source === "Historical downloads"
    );
    assertEquals(downloadRoots.map((root) => [root.props.path, root.props.files]), [["/downloads", [
      { path: "episode", size: 10 },
    ]]]);
    assertEquals(downloadRoots[0].findByType(ActiveServiceMark).props.historical, true);
    assertEquals(
      tree.findAllByType(PathTreeRoot).find((root) => root.props.source === "Sonarr")!.findByType(
        ActiveServiceMark,
      ).props.historical,
      undefined,
    );
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
    await toggleSonarr(true);
    assertEquals(previewReads, 3);
    assertEquals(historyReads, 0);
    // Checkbox changes use the same inventory and withdraw optional consent.
    await toggleSonarr(false);
    assertEquals(
      renderer!.root.findAllByType(ActiveServiceMark).filter((mark) => mark.props.historical)
        .length,
      0,
    );

    assertEquals(
      renderer!.root.findAllByProps({ "aria-label": "Remove history-linked download files" })
        .length,
      0,
    );
    assertEquals(renderer!.root.findByType(ServiceDeletionPreviewList).props.historical, undefined);
    await settleReact(() => renderer!.root.findByType(DeletionDialogFooter).props.onConfirm());
    assertEquals(requests[2].arrSelected, false);
    assertEquals(requests[2].historicalCleanup, undefined);
    assertEquals(previewReads, 3);
    assertEquals(requests[1].consentToken, "bound-scope");
    // A batch may include historical files for only one of its Sonarr titles.
    const targets = ["sonarr-file", "unrelated-file"].map((actionId) => ({
      ...preview.targets[0],
      ratingKey: actionId,
      decisions: [{
        ...preview.targets[0].decisions[0],
        actionId,
        requested: true,
        state: "delete_candidate" as const,
      }],
    }));
    await settleReact(() =>
      renderer!.update(
        <ServiceDeletionPreviewList preview={{ ...preview, targets }} historical={historical} />,
      )
    );
    assertEquals(
      renderer!.root.findAllByType(ActiveServiceMark).map((mark) => mark.props.historical),
      [true, false],
    );
    await settleReact(() =>
      renderer!.update(
        <ServiceDeletionPreviewList
          preview={{ ...preview, targets }}
          historical={{ ...historical, candidates: [] }}
        />,
      )
    );
    assertEquals(
      renderer!.root.findAllByType(ActiveServiceMark).map((mark) => mark.props.historical),
      [false, false],
    );
  } finally {
    await settleReact(() => {
      renderer?.unmount();
    });
    Object.assign(api.serviceDeletions, original);
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

Deno.test("QB selection is independent and never requests another history inventory", async () => {
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
      discovery: true,
      historical: { ...historical, candidates: [] },
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
    assertEquals(selections, []);
    await settleReact(() => {
      renderer!.root.findByType(DestinationOptions).props.options.find((o: { id: string }) =>
        o.id === "arr"
      ).onChange(true);
    });
    await toggle(true);
    assertEquals(
      renderer!.root.findAllByProps({ "aria-label": "Remove history-linked download files" })
        .length,
      0,
    );
    await toggle(false);

    assertEquals(selections, []);
    assertEquals(
      renderer!.root.findByType(ServiceDeletionPreviewList).props.historical.candidates,
      [],
    );
  } finally {
    await settleReact(() => renderer?.unmount());
    Object.assign(api.serviceDeletions, original);
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
