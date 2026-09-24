// deno-lint-ignore-file require-await -- React async act flushes effects and microtasks.
/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import TestRenderer, { act } from "react-test-renderer";
import {
  HistoricalDownloadPaths,
  historicalOutcomeDescription,
} from "./HistoricalDownloadPaths.tsx";

Deno.test("legacy changed outcomes explain uncertainty without claiming files remain or were deleted", () => {
  const outcome = {
    path: "/download/file",
    status: "changed" as const,
    reason: "changed",
    intentAt: null,
    finishedAt: null,
  };
  assertEquals(
    historicalOutcomeDescription(outcome),
    "Local cleanup was not performed because verification no longer matched. This older result did not record which check failed; it does not establish whether the file remains. Check the service outcomes.",
  );
  assertEquals(
    historicalOutcomeDescription({ ...outcome, reason: "Download ownership changed" }),
    "Needs review (changed) — Download ownership changed",
  );
});

Deno.test("confirmed delegated cleanup is distinct from local deletion, absence and unresolved work", () => {
  const outcome = {
    path: "/download/file",
    status: "handled_by_qb",
    reason: null,
    intentAt: null,
    finishedAt: 1,
  };
  assertEquals(
    historicalOutcomeDescription(outcome),
    "Handled by qBittorrent — selected job removal confirmed",
  );
  assertEquals(historicalOutcomeDescription({ ...outcome, status: "success" }), "Deleted locally");
  assertEquals(
    historicalOutcomeDescription({ ...outcome, status: "already_absent" }),
    "Already absent",
  );
  assertEquals(
    historicalOutcomeDescription({ ...outcome, status: "uncertain", reason: "Check job outcomes" }),
    "Needs review (uncertain) — Check job outcomes",
  );
});

Deno.test("historical review renders bounded pages and exposes every exact candidate and skip", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <HistoricalDownloadPaths
          preview={{
            fingerprint: "fixture",
            candidates: Array.from(
              { length: 101 },
              (_, i) => ({ id: String(i), path: `/download/${i}`, ownerCount: 1, size: 2 }),
            ),
            skipped: [{
              source: "/kept",
              reason: "Retained owner",
              details: "download root: invalid ino 0",
            }],
            handled: [{ source: "/tracked", service: "qb", actionIds: ["job"] }],
          }}
        />,
      );
    });
    assertEquals(renderer.root.findAllByType("p").length, 0);
    await act(async () => {
      renderer.root.findAllByType("details")[0].props.onToggle({ currentTarget: { open: true } });
    });
    assertEquals(renderer.root.findAllByType("p").length, 51);
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        renderer.root.findAllByType("button")[1].props.onClick();
      });
    }
    assertEquals(renderer.root.findAllByType("p").map((p) => p.children.join("")), [
      "Consent includes all 101 listed paths. 101–103 of 103 paths shown.",
      "/download/100 · 1 episode owners",
      "/kept: Retained owner",
      "/tracked: Covered by selected qBittorrent action; removal not yet confirmed",
    ]);
    assertEquals(renderer.root.findAllByType("button")[1].props.disabled, true);
    const technical = renderer.root.findAllByType("details")[1];
    assertEquals(technical.props.open, undefined);
    assertEquals(technical.findByType("summary").children, ["Technical details"]);
    assertEquals(technical.findByType("pre").children, ["download root: invalid ino 0"]);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

Deno.test("historical operation outcomes render bounded pages with exact failure reasons", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <HistoricalDownloadPaths
          outcomes={Array.from({ length: 51 }, (_, i) => ({
            path: `/download/${i}`,
            status: "changed",
            reason: "Owner changed",
            intentAt: null,
            finishedAt: null,
          }))}
        />,
      );
    });
    assertEquals(renderer.root.findAllByType("p").length, 0);
    await act(async () =>
      renderer.root.findByType("details").props.onToggle({ currentTarget: { open: true } })
    );
    assertEquals(renderer.root.findAllByType("p").length, 51);
    await act(async () => renderer.root.findAllByType("button")[1].props.onClick());
    assertEquals(renderer.root.findAllByType("p").map((p) => p.children.join("")), [
      "51–51 of 51 paths shown.",
      "/download/50: Needs review (changed) — Owner changed",
    ]);
  } finally {
    await act(async () => renderer?.unmount());
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
