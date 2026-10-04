import { assertEquals } from "@std/assert";
import {
  cleanEpisodeGapFixture,
  cleanSeasonGapFixture,
  episodeGapFixture,
  seasonGapFixture,
} from "../fixtures.ts";
import {
  hasRetainedEpisodeAuditFindings,
  isEpisodeAuditUninitialized,
  needsEpisodeAuditSummary,
} from "./auditState.ts";

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

Deno.test("pending summary cannot classify empty retained findings as a first audit", () => {
  const { summary, ...page } = episodeGapFixture;
  const emptyPage = {
    ...page,
    rows: [],
    libraryAudits: page.libraryAudits.map((audit) => ({ ...audit, episodeAuditSyncedAt: null })),
  };
  assertEquals(needsEpisodeAuditSummary(emptyPage, undefined), true);
  assertEquals(isEpisodeAuditUninitialized(emptyPage), false);
  assertEquals(isEpisodeAuditUninitialized(emptyPage, { scope: "episode", summary }), false);
  assertEquals(hasRetainedEpisodeAuditFindings(emptyPage, { scope: "episode", summary }), true);
  assertEquals(needsEpisodeAuditSummary(page, undefined), false);
});

Deno.test("known zero summary can confirm a first audit after independent page loading", () => {
  const { summary, ...page } = cleanSeasonGapFixture;
  const emptyPage = {
    ...page,
    libraryAudits: page.libraryAudits.map((audit) => ({ ...audit, episodeAuditSyncedAt: null })),
  };
  assertEquals(isEpisodeAuditUninitialized(emptyPage), false);
  assertEquals(isEpisodeAuditUninitialized(emptyPage, { scope: "season", summary }), true);
  assertEquals(needsEpisodeAuditSummary(emptyPage, { scope: "season", summary }), false);
  assertEquals(needsEpisodeAuditSummary({ ...emptyPage, libraryAudits: [] }, undefined), false);
});

Deno.test("summary from a different scope cannot establish audit confidence", () => {
  const { summary: _summary, ...page } = cleanEpisodeGapFixture;
  const emptyPage = {
    ...page,
    libraryAudits: page.libraryAudits.map((audit) => ({ ...audit, episodeAuditSyncedAt: null })),
  };
  assertEquals(isEpisodeAuditUninitialized(emptyPage, cleanSeasonGapFixture), false);
  assertEquals(needsEpisodeAuditSummary(emptyPage, cleanSeasonGapFixture), true);
});
