// deno-lint-ignore-file require-await -- React async act flushes effects and microtasks.
/// <reference lib="dom" />
import { assertEquals } from "@std/assert";
import TestRenderer, { act } from "react-test-renderer";
import { HistoricalDownloadPaths } from "./HistoricalDownloadPaths.tsx";

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
      "/tracked: Handled by qBittorrent (selected eligible action)",
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
      "/download/50: changed — Owner changed",
    ]);
  } finally {
    await act(async () => renderer?.unmount());
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
