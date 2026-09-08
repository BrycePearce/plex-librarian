import { assertEquals } from "@std/assert";
import {
  seasonCleanupAvailable,
  seasonSonarrActionAvailable,
  seasonSonarrOptionInfo,
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

Deno.test("stale-season Sonarr warnings preserve the ownership contract", () => {
  const info = seasonSonarrOptionInfo("qBittorrent inspection failed");
  assertEquals(info.includes("current managed files"), true);
  assertEquals(info.includes("qBittorrent inspection failed"), true);
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
