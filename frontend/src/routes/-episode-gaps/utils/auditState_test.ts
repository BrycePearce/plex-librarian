import { assertEquals } from "@std/assert";
import {
  cleanEpisodeGapFixture,
  cleanSeasonGapFixture,
  episodeGapFixture,
  seasonGapFixture,
} from "../fixtures.ts";
import { isEpisodeAuditUninitialized } from "./auditState.ts";

Deno.test("retained episode findings stay visible while every audit marker is null", () => {
  const refreshing = {
    ...episodeGapFixture,
    libraryAudits: episodeGapFixture.libraryAudits.map((audit) => ({
      ...audit,
      episodeAuditSyncedAt: null,
    })),
  };
  assertEquals(isEpisodeAuditUninitialized(refreshing), false);
  assertEquals(isEpisodeAuditUninitialized({ ...refreshing, rows: [] }), false);
});

Deno.test("empty libraries with no completed audit use the first-audit state", () => {
  const uninitialized = {
    ...cleanEpisodeGapFixture,
    libraryAudits: cleanEpisodeGapFixture.libraryAudits.map((audit) => ({
      ...audit,
      episodeAuditSyncedAt: null,
    })),
  };
  assertEquals(isEpisodeAuditUninitialized(uninitialized), true);
  assertEquals(isEpisodeAuditUninitialized({ ...uninitialized, libraryAudits: [] }), false);
});

Deno.test("season findings use the shared audit freshness state", () => {
  const refreshing = {
    ...seasonGapFixture,
    libraryAudits: seasonGapFixture.libraryAudits.map((audit) => ({
      ...audit,
      episodeAuditSyncedAt: null,
    })),
  };
  assertEquals(isEpisodeAuditUninitialized(refreshing), false);

  const uninitialized = {
    ...cleanSeasonGapFixture,
    libraryAudits: cleanSeasonGapFixture.libraryAudits.map((audit) => ({
      ...audit,
      episodeAuditSyncedAt: null,
    })),
  };
  assertEquals(isEpisodeAuditUninitialized(uninitialized), true);
});
