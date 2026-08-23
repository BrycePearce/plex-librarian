import { assertEquals } from "@std/assert";
import {
  seasonCleanupAvailable,
  seasonSonarrActionAvailable,
  usableSeasonRemovalPreview,
} from "./SeasonRemovalDialog.tsx";

Deno.test("season cleanup option appears only for a detected qBittorrent job", () => {
  assertEquals(seasonCleanupAvailable(undefined), false);
  assertEquals(
    seasonCleanupAvailable({ cleanupConfigured: false, downloadJobs: [{} as never] }),
    false,
  );
  assertEquals(seasonCleanupAvailable({ cleanupConfigured: true, downloadJobs: [] }), false);
  assertEquals(
    seasonCleanupAvailable({ cleanupConfigured: true, downloadJobs: [{} as never] }),
    true,
  );
});

Deno.test("season Sonarr option appears only for a detected action", () => {
  assertEquals(seasonSonarrActionAvailable(undefined), false);
  assertEquals(seasonSonarrActionAvailable({ sonarrActionAvailable: false }), false);
  assertEquals(seasonSonarrActionAvailable({ sonarrActionAvailable: true }), true);
});

Deno.test("a failed season preview never exposes retained placeholder data", () => {
  const stale = { fingerprint: "stale" };
  assertEquals(usableSeasonRemovalPreview(stale, new Error("verification failed")), undefined);
  assertEquals(usableSeasonRemovalPreview(stale, null), stale);
});
