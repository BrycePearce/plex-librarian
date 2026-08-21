import { assertEquals } from "@std/assert";
import { arrCleanupTargetImpact } from "./DeletionPlanSummary.tsx";

Deno.test("Sonarr deletion impact totals exact season summaries", () => {
  assertEquals(
    arrCleanupTargetImpact({
      instanceName: "Sonarr",
      type: "sonarr",
      title: "The 100",
      path: "/data/TV/The 100",
      seasons: [
        { seasonNumber: 1, episodeFileCount: 13, size: 10_000 },
        { seasonNumber: 2, episodeFileCount: 16, size: 20_000 },
      ],
      mediaFiles: null,
      extraFiles: null,
    }),
    {
      key: "Sonarr:/data/TV/The 100",
      title: "The 100",
      path: "/data/TV/The 100",
      fileCount: 29,
      sizeBytes: 30_000,
    },
  );
});

Deno.test("Radarr deletion impact stays honest when managed details are incomplete", () => {
  assertEquals(
    arrCleanupTargetImpact({
      instanceName: "Radarr",
      type: "radarr",
      title: "Arrival",
      path: "/data/Movies/Arrival",
      seasons: null,
      mediaFiles: null,
      extraFiles: null,
    }),
    {
      key: "Radarr:/data/Movies/Arrival",
      title: "Arrival",
      path: "/data/Movies/Arrival",
      fileCount: null,
      sizeBytes: null,
    },
  );
});
