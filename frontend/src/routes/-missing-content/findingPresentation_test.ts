import { assertEquals, assertStringIncludes } from "@std/assert";
import type { MissingContentResponse } from "../../../../shared/missingContent.ts";
import { findingPresentation } from "./findingPresentation.ts";

type Row = MissingContentResponse["rows"][number];
function finding(): Row {
  return {
    instanceId: 1,
    libraryKey: "1",
    movieId: 1,
    type: "unable",
    title: "A movie",
    firstSeen: 1,
    lastSeen: 1,
    stale: false,
    dismissed: false,
    evidence: {
      reason:
        "Trusted path comparison or catalog identity evidence is incomplete. No absence is inferred.",
      auditedAt: 100000,
      comparablePath: null,
      pending: false,
      movie: {
        id: 1,
        title: "A movie",
        year: 2021,
        slug: "a-movie",
        tmdb: "123",
        imdb: "tt123",
        fileId: 2,
        path: "/movies/a.mkv",
        importedAt: 1,
      },
      matches: [],
    },
  };
}

Deno.test("legacy unmatched identity stays inconclusive without inventing a cause", () => {
  const presentation = findingPresentation(finding());
  assertEquals(presentation.label, "No identity match");
  assertStringIncludes(presentation.explanation, "not a confirmed missing movie");
  assertStringIncludes(presentation.summary, "File comparison is unavailable");
  assertEquals(/waiting for plex|scan failed|out of sync/i.test(presentation.explanation), false);
});

Deno.test("legacy diagnoses preserve file and ambiguity precedence over pending import", () => {
  const row = finding();
  row.evidence.pending = true;
  row.evidence.movie.fileId = null;
  assertEquals(findingPresentation(row).label, "File details unavailable");
  row.evidence.movie.fileId = 2;
  row.evidence.matches = ["1", "2"].map((ratingKey) => ({
    ratingKey,
    title: "A movie",
    tmdb: ["123"],
    imdb: [],
    paths: [],
    exact: false,
  }));
  assertEquals(findingPresentation(row).label, "Multiple Plex matches");
});

Deno.test("legacy import reasons remain distinct and use audit evidence rather than current time", () => {
  const row = finding();
  row.evidence.pending = true;
  assertEquals(findingPresentation(row).label, "In Radarr’s queue");
  row.evidence.pending = false;
  row.evidence.reason = "Within the 24-hour import grace period. Rechecked on the next sync.";
  assertEquals(findingPresentation(row).label, "Recently imported");
  row.evidence.reason = "Import time is unknown; missing content cannot yet be established.";
  assertEquals(findingPresentation(row).label, "Import date unknown");
});

Deno.test("structured diagnosis takes precedence over legacy prose", () => {
  const row = finding();
  row.evidence.diagnosis = { code: "import_time_unknown" };
  assertEquals(findingPresentation(row).label, "Import date unknown");
  row.evidence.diagnosis = { code: "evidence_incomplete", limitations: ["plex_paths_incomplete"] };
  row.evidence.comparablePath = "/shared/a.mkv";
  assertStringIncludes(
    findingPresentation(row).explanation,
    "Plex file paths could not all be compared",
  );
});

Deno.test("missing identifiers are distinguished from unmatched identifiers", () => {
  const row = finding();
  row.evidence.movie.tmdb = null;
  row.evidence.movie.imdb = null;
  assertEquals(findingPresentation(row).label, "Movie IDs unavailable");
  assertStringIncludes(findingPresentation(row).nextStep, "Radarr");
});

Deno.test("matching raw paths never imply the stored file is verified", () => {
  const row = finding();
  row.type = "version";
  row.evidence.matches = [{
    ratingKey: "1",
    title: "A movie",
    tmdb: ["123"],
    imdb: [],
    paths: [row.evidence.movie.path!],
    exact: false,
  }];
  const presentation = findingPresentation(row);
  assertEquals(presentation.plexSummary, "Movie identity matched");
  assertStringIncludes(presentation.explanation, "cannot confirm the exact");
  assertStringIncludes(presentation.nextStep, "No movie repair is indicated");
});

Deno.test("metadata mismatch distinguishes identity-only and trusted-path evidence", () => {
  const row = finding();
  row.type = "metadata";
  row.evidence.reason =
    "Conflicting imdb identifiers. An external identity matches, but the managed version is unverified.";
  row.evidence.matches = [{
    ratingKey: "1",
    title: "A movie",
    tmdb: ["123"],
    imdb: ["tt999"],
    paths: [],
    exact: false,
  }];
  assertStringIncludes(findingPresentation(row).summary, "another ID disagrees");
  row.evidence.matches[0].exact = true;
  assertStringIncludes(findingPresentation(row).summary, "managed path matches");
  row.evidence.reason =
    "Plex lacks imdb identifiers. The exact managed path is present in the catalog.";
  assertEquals(findingPresentation(row).label, "Plex IDs incomplete");
});

Deno.test("confirmed absence is scoped to Plex catalog, not physical files", () => {
  const row = finding();
  row.type = "missing";
  const presentation = findingPresentation(row);
  assertEquals(presentation.label, "Missing from Plex");
  assertStringIncludes(presentation.explanation, "does not prove the file is missing from disk");
});
