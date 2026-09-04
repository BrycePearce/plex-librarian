import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import {
  sonarrRetainedPathsSummary,
  SonarrRetainedPathsWarning,
  sonarrRetainedPathsWarningCopy,
} from "./SonarrRetainedPathsWarning.tsx";
import type { SonarrHistoricalPathPreview } from "@shared/types";

function path(
  disposition: SonarrHistoricalPathPreview["disposition"],
  reason: string,
): SonarrHistoricalPathPreview {
  return {
    path: `/downloads/${disposition}.mkv`,
    managedPath: "/media/show/episode.mkv",
    size: 100,
    disposition,
    reason,
  };
}

async function renderWarning(paths: SonarrHistoricalPathPreview[]): Promise<string> {
  const rootRoute = createRootRoute({
    component: () => <SonarrRetainedPathsWarning paths={paths} />,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/sonarr-radarr",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

Deno.test("basic preview warning counts retained paths and reports the first unverified reason", () => {
  const summary = sonarrRetainedPathsSummary([
    path("delete", "verified two-link proof"),
    path("unverified", "the download root is not mapped"),
    path("unverified", "the path is outside the configured root"),
  ]);
  assertEquals(summary, {
    count: 2,
    unverifiedCount: 2,
    firstUnverifiedReason: "the download root is not mapped",
    liveOwnerCount: 0,
    firstLiveOwnerReason: null,
  });
  assertEquals(
    sonarrRetainedPathsWarningCopy(summary!).detail,
    "2 paths could not be verified: the download root is not mapped. Full logical-media-byte reclamation is not expected, so physical disk space may remain occupied.",
  );
});

Deno.test("basic preview warning distinguishes an unselected live qBittorrent owner", () => {
  const summary = sonarrRetainedPathsSummary([
    path("retain_live_qbittorrent", "a live job owns the exact path"),
  ]);
  assertEquals(sonarrRetainedPathsWarningCopy(summary!), {
    heading: "1 known historical Sonarr path will be retained",
    detail:
      "Live qBittorrent owner retained a path: a live job owns the exact path. Full logical-media-byte reclamation is not expected, so physical disk space may remain occupied.",
  });
});

Deno.test("basic preview warning preserves mixed retention reasons", () => {
  const summary = sonarrRetainedPathsSummary([
    path("unverified", "the download root is not mapped"),
    path("retain_live_qbittorrent", "an unselected live job owns the exact path"),
  ]);
  assertEquals(summary, {
    count: 2,
    unverifiedCount: 1,
    firstUnverifiedReason: "the download root is not mapped",
    liveOwnerCount: 1,
    firstLiveOwnerReason: "an unselected live job owns the exact path",
  });
  assertEquals(
    sonarrRetainedPathsWarningCopy(summary!).detail,
    "Path could not be verified: the download root is not mapped. Live qBittorrent owner retained a path: an unselected live job owns the exact path. Full logical-media-byte reclamation is not expected, so physical disk space may remain occupied.",
  );
});

Deno.test("retained-path alert renders concrete reason and Media connections link", async () => {
  const html = await renderWarning([
    path("unverified", "download mapping does not cover this path"),
  ]);
  assertStringIncludes(html, 'role="alert"');
  assertStringIncludes(html, "1 known historical Sonarr path will be retained");
  assertStringIncludes(html, "download mapping does not cover this path");
  assertStringIncludes(html, "Full logical-media-byte reclamation is not expected");
  assertStringIncludes(html, 'href="/settings/sonarr-radarr"');

  const liveOwner = await renderWarning([
    path("retain_live_qbittorrent", "a live job owns the exact path"),
  ]);
  assertStringIncludes(liveOwner, "Live qBittorrent owner retained a path");
});
