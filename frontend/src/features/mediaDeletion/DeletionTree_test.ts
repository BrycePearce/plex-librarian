import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { DownloadCleanupPreviewItem } from "@shared/types";
import { AdvancedDeletionTree, PathTreeRoot } from "./DeletionTree.tsx";

Deno.test("file preview preserves distinct case-sensitive service paths", async () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(() => {
      renderer = TestRenderer.create(createElement(PathTreeRoot, {
        path: "/media",
        files: [
          { path: "Season/Episode.mkv", size: 1000 },
          { path: "Season/episode.mkv", size: 2000 },
          { path: "season/Episode.mkv", size: 3000 },
        ],
      }));
    });
    const names = renderer!.root.findAllByType("span").map((span) => span.props.title);
    assertEquals(names.filter((name) => name === "Episode.mkv").length, 2);
    assertEquals(names.filter((name) => name === "episode.mkv").length, 1);
    assertEquals(names.includes("Season"), true);
    assertEquals(names.includes("season"), true);
  } finally {
    if (renderer) await act(() => renderer!.unmount());
  }
});

Deno.test("ordinary preview renders current paths without legacy historical effects", async () => {
  const preview = {
    status: "resolved",
    arrStatus: "unavailable",
    downloadJobs: [],
    plexPaths: ["/library/current.mkv"],
    orphanFiles: [{ path: "/historical/orphan.mkv", size: 100, method: "hardlink" }],
    retainedPaths: [{ path: "/historical/retained.mkv", reason: "live owner" }],
    sonarrHistoricalPaths: [{ path: "/historical/import.mkv", disposition: "delete" }],
  } as unknown as DownloadCleanupPreviewItem;
  for (const deleteFromArr of [false, true]) {
    for (const cleanupDownloads of [false, true]) {
      let renderer!: TestRenderer.ReactTestRenderer;
      try {
        await act(() => {
          renderer = TestRenderer.create(createElement(AdvancedDeletionTree, {
            items: [{
              ratingKey: "show",
              libraryKey: "tv",
              title: "Fixture",
              type: "show",
              fileSize: 100,
            }],
            plexPreviews: new Map([["show", preview]]),
            deleteFromArr,
            cleanupDownloads,
            loading: false,
          }));
        });
        const rendered = JSON.stringify(renderer.toJSON());
        assertStringIncludes(rendered, "/library/current.mkv");
        assertEquals(rendered.includes("/historical/"), false);
        assertEquals(rendered.includes("Automatic unlink"), false);
      } finally {
        if (renderer) await act(() => renderer.unmount());
      }
    }
  }
});
