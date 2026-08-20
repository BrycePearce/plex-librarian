import { assertEquals } from "@std/assert";
import { seasonCleanupAvailable, seasonSonarrActionAvailable } from "./SeasonRemovalDialog.tsx";

Deno.test("season cleanup option appears only for a detected qBittorrent job", () => {
  assertEquals(seasonCleanupAvailable(undefined), false);
  assertEquals(seasonCleanupAvailable({ downloadJobs: [] }), false);
  assertEquals(
    seasonCleanupAvailable({ downloadJobs: [{} as never] }),
    true,
  );
});

Deno.test("season Sonarr option appears only for a detected action", () => {
  assertEquals(seasonSonarrActionAvailable(undefined), false);
  assertEquals(seasonSonarrActionAvailable({ sonarrActionAvailable: false }), false);
  assertEquals(seasonSonarrActionAvailable({ sonarrActionAvailable: true }), true);
});
