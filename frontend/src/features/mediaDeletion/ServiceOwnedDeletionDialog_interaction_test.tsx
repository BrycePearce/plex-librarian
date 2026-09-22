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
import { DeletionDialogFooter, DeletionModalShell } from "./DeletionDialog.tsx";
import { ServiceDeletionPreviewList } from "./ServiceDeletionPreviewList.tsx";
import type {
  ServiceActionDecision,
  ServiceDeletionChoices,
  ServiceDeletionPreview,
  ServiceDeletionRequest,
} from "../../../../shared/serviceOwnedDeletion.ts";

Deno.test("version review distinguishes same-quality files and retains deduplicated safety warnings", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await flushAct(() => {
      renderer = TestRenderer.create(
        <ServiceDeletionPreviewList
          preview={{
            fingerprint: "current",
            arrConfigured: true,
            qbConfigured: true,
            canConfirm: true,
            targets: ["release-one.mkv", "release-two.mkv"].map((fileName, index) => ({
              ratingKey: "episode",
              mediaId: index + 1,
              title: "Pilot",
              showTitle: "Example Show",
              seasonIndex: 1,
              episodeIndex: 2,
              videoResolution: "1080",
              fileName,
              decisions: [1, 2].map((id) => ({
                actionId: String(id),
                targetId: "episode",
                service: "plex" as const,
                requested: true,
                state: "kept" as const,
                presence: "current" as const,
                reason: "A retained download uses this path",
                evidenceRevision: "current",
              })),
            })),
          }}
        />,
      );
    });
    const rows = renderer!.root.findAllByType("li");
    assertEquals(rows.length, 2);
    for (const [index, row] of rows.entries()) {
      const title = row.findAllByType("span").find((span) => span.props.title)?.props.title;
      assertEquals(title, `Example Show · S01E02 · Pilot · release-${index ? "two" : "one"}.mkv`);
    }
    const warnings = renderer!.root.findAllByType("p").filter((p) =>
      p.children.join("").includes("This media will remain in Plex")
    );
    assertEquals(warnings.length, 2);
  } finally {
    await flushAct(() => renderer?.unmount());
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

Deno.test("review lists a show once and only offers detected destinations, keeping unknown reads visible", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const oldPreview = api.serviceDeletions.preview;
  const action = (
    service: ServiceActionDecision["service"],
    presence: ServiceActionDecision["presence"],
    id: string,
  ): ServiceActionDecision => ({
    actionId: id,
    targetId: id,
    service,
    presence,
    matchedToSelection: service === "qb" && presence === "current",
    requested: service === "plex",
    state: presence === "unknown" ? "held" : presence === "absent" ? "not_applicable" : "kept",
    reason: presence === "unknown" ? "Current inventory could not be read" : "Not selected",
    evidenceRevision: "current",
  });
  let result: ServiceDeletionPreview = {
    fingerprint: "current",
    arrConfigured: true,
    qbConfigured: true,
    canConfirm: true,
    targets: [{
      ratingKey: "show",
      title: "Legend of the Seeker",
      fileSize: 1024,
      decisions: [
        ...Array.from(
          { length: 60 },
          (_, index) => action("sonarr", "current", `episode-${index}`),
        ),
        action("qb", "absent", "qb"),
      ],
    }],
  };
  api.serviceDeletions.preview = () => Promise.resolve(result);
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const render = (key: string) => (
    <ServiceOwnedDeletionDialog
      dialogRef={{ current: null }}
      libraryKey="tv"
      targets={[{ ratingKey: key }]}
      embedded
      onCreated={() => {}}
      onCancel={() => {}}
    />
  );
  const text = () => JSON.stringify(renderer!.toJSON());
  try {
    await flushAct(() => {
      renderer = TestRenderer.create(render("one"));
    });
    assertEquals(renderer!.root.findAllByType("input").length, 1);
    assertEquals(renderer!.root.findAllByType("li").length, 1);
    assertEquals(text().includes("Not selected"), false);
    assertEquals(text().includes("Delete from "), true);
    assertEquals(text().includes("Sonarr"), true);
    result = {
      ...result,
      targets: [{
        ratingKey: "show",
        title: "No match",
        decisions: [action("sonarr", "absent", "arr"), action("qb", "absent", "qb")],
      }],
    };
    await flushAct(() => {
      renderer!.update(render("two"));
    });
    assertEquals(renderer!.root.findAllByType("input").length, 0);
    result = {
      ...result,
      canConfirm: false,
      targets: [{
        ratingKey: "show",
        title: "Unreadable",
        decisions: [action("sonarr", "unknown", "arr"), action("qb", "unknown", "qb")],
      }],
    };
    await flushAct(() => {
      renderer!.update(render("three"));
    });
    assertEquals(renderer!.root.findAllByType("input").length, 0);
    assertEquals(text().includes("Current inventory could not be read"), true);
    assertEquals(
      renderer!.root.findByType(DeletionDialogFooter).props.confirmDisabled,
      true,
    );
    result = {
      ...result,
      targets: [{
        ratingKey: "movie",
        title: "Movie",
        decisions: [action("radarr", "current", "arr"), action("qb", "current", "qb")],
      }],
    };
    await flushAct(() => {
      renderer!.update(render("four"));
    });
    assertEquals(renderer!.root.findAllByType("input").length, 2);
    assertEquals(text().includes("Radarr"), true);
    assertEquals(text().includes("Sonarr"), false);
    result = {
      ...result,
      targets: [{
        ratingKey: "movie",
        title: "Overlap only",
        decisions: [{ ...action("qb", "current", "qb"), matchedToSelection: false }],
      }],
    };
    await flushAct(() => {
      renderer!.update(render("overlap-only"));
    });
    assertEquals(renderer!.root.findAllByType("input").length, 0);
  } finally {
    await flushAct(() => renderer?.unmount());
    api.serviceDeletions.preview = oldPreview;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

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
      targets: [{
        ratingKey: "one",
        title: "Example",
        decisions: ["sonarr", "qb"].map((service) => ({
          actionId: service,
          targetId: service,
          service: service as "sonarr" | "qb",
          presence: "current" as const,
          matchedToSelection: true,
          requested: false,
          state: "kept" as const,
          reason: "Not selected",
          evidenceRevision: "current",
        })),
      }],
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
      renderer!.root.findAllByType("button").find((entry) =>
        entry.findAllByType("span").some((span) => span.children.includes(label)) ||
        entry.children.includes(label)
      )!;
    assertEquals(inputs().map((entry) => entry.props.checked), [false, false]);
    await flushAct(() => {
      inputs()[0].props.onChange({ target: { checked: true } });
    });
    assertEquals(previews.length, 1);
    assertEquals(inputs()[0].props.checked, true);
    assertEquals(
      renderer!.root.findAllByType("button").some((entry) => entry.children.includes("Refresh")),
      false,
    );
    await flushAct(() => {
      inputs()[0].props.onChange({ target: { checked: false } });
    });
    await flushAct(() => {
      inputs()[1].props.onChange({ target: { checked: true } });
    });
    await flushAct(() => {
      renderer!.update(render("two"));
    });
    assertEquals(inputs().map((entry) => entry.props.checked), [false, false]);
    await flushAct(() => {
      button("Confirm deletion").props.onClick();
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
    assertEquals(
      renderer!.root.findAllByType("button").some((entry) => entry.children.includes("Retry")),
      false,
    );
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
      targets: [{
        ratingKey: "one",
        title: "Example",
        decisions: ["sonarr", "qb"].map((service) => ({
          actionId: service,
          targetId: service,
          service: service as "sonarr" | "qb",
          presence: "current" as const,
          matchedToSelection: true,
          requested: false,
          state: "kept" as const,
          reason: "Not selected",
          evidenceRevision: "current",
        })),
      }],
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
      renderer!.root.findAllByType("button").find((entry) =>
        entry.findAllByType("span").some((span) => span.children.includes(label)) ||
        entry.children.includes(label)
      )!;
    await flushAct(() => {
      button("Confirm deletion").props.onClick();
    });
    assertEquals(button("Confirm deletion").props.disabled, true);
    assertEquals(button("Retry").props.disabled, false);
    failRead = true;
    await flushAct(() => {
      button("Retry").props.onClick();
    });
    assertEquals(button("Confirm deletion").props.disabled, true);
    assertEquals(renderer!.root.findAllByType("input").map((input) => input.props.checked), []);
    failRead = false;
    await flushAct(() => {
      button("Retry").props.onClick();
    });
    assertEquals(button("Confirm deletion").props.disabled, false);
  } finally {
    await flushAct(() => {
      renderer?.unmount();
    });
    api.serviceDeletions.preview = oldPreview;
    api.serviceDeletions.create = oldCreate;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
Deno.test("restored advanced preview shows real paths with retained decisions and truncation", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await flushAct(() => {
      renderer = TestRenderer.create(
        <ServiceDeletionPreviewList
          preview={{
            fingerprint: "current",
            arrConfigured: true,
            qbConfigured: false,
            canConfirm: true,
            targets: [{
              ratingKey: "show",
              title: "Example Show",
              fileCount: 1001,
              filesTruncated: true,
              linkedExtrasIncluded: true,
              decisions: [
                {
                  actionId: "plex",
                  targetId: "show",
                  service: "plex",
                  requested: true,
                  state: "kept",
                  presence: "current",
                  reason: "A kept torrent uses this file",
                  evidenceRevision: "current",
                },
                {
                  actionId: "arr",
                  targetId: "show",
                  service: "sonarr",
                  requested: false,
                  state: "kept",
                  presence: "current",
                  reason: "Not selected",
                  evidenceRevision: "current",
                },
              ],
              files: [
                {
                  actionId: "plex",
                  service: "plex",
                  path: "/media/tv/Example/Season 1/Episode.mkv",
                  size: 2048,
                },
                {
                  actionId: "arr",
                  service: "sonarr",
                  path: "/arr/Example/Episode.mkv",
                  size: 2048,
                },
              ],
            }],
          }}
        />,
      );
    });
    assertEquals(renderer!.root.findAllByType("li").length, 1);
    await flushAct(() => {
      renderer!.root.findAllByType("button").find((button) => button.children.includes("advanced"))!
        .props.onClick();
    });
    const output = JSON.stringify(renderer!.toJSON());
    assertEquals(output.includes("/media/tv/Example/Season 1"), true);
    assertEquals(output.includes("Episode.mkv"), true);
    assertEquals(output.includes("These files will be kept"), true);
    assertEquals(output.includes("1001"), true);
    assertEquals(output.includes("/arr/Example"), false);
    assertEquals(output.includes("Sonarr also handles"), false);
    assertEquals(
      renderer!.root.findAllByType("button").some((button) =>
        button.props["aria-label"] === "Copy path /media/tv/Example/Season 1"
      ),
      true,
    );
  } finally {
    await flushAct(() => renderer?.unmount());
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
