import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import type { MissingContentResponse } from "../../../../shared/missingContent.ts";
import { FindingDetails } from "./FindingDetails.tsx";
function finding(): MissingContentResponse["rows"][number] {
  return {
    instanceId: 1,
    libraryKey: "1",
    movieId: 2,
    type: "unable",
    title: "Example",
    firstSeen: 1,
    lastSeen: 2,
    dismissed: false,
    stale: false,
    evidence: {
      reason:
        "Trusted path comparison or catalog identity evidence is incomplete. No absence is inferred.",
      auditedAt: 2,
      comparablePath: null,
      pending: false,
      movie: {
        id: 2,
        title: "Example",
        year: 2021,
        slug: "example",
        tmdb: "12",
        imdb: "tt123",
        fileId: 3,
        path: "/Movies/Example (2014).mkv",
        importedAt: 1,
      },
      matches: [],
    },
  };
}
Deno.test("finding actions, meaningful evidence and filename are visible before technical disclosure", () => {
  const html = renderToStaticMarkup(
    <FindingDetails row={finding()} dismiss={() => {}} disabled={false} />,
  );
  const visible = html.split("<details")[0];
  assertStringIncludes(visible, "Open Radarr");
  assertStringIncludes(visible, "No matching movie ID found");
  assertStringIncludes(visible, "Example (2014).mkv");
  assertEquals(visible.includes("TMDB"), false);
  assertStringIncludes(html, "TMDB");
  assertStringIncludes(visible, "not a confirmed missing movie");
  assertStringIncludes(visible, "Next step");
  assertEquals(visible.includes("Open Plex"), false);
});
Deno.test("metadata comparison exposes conflicting IDs and Plex action; stale evidence is identified", () => {
  const row = finding();
  row.type = "metadata";
  row.stale = true;
  row.evidence.matches = [{
    ratingKey: "7",
    title: "Example",
    tmdb: ["12"],
    imdb: ["tt456"],
    paths: [],
    exact: false,
  }];
  const html = renderToStaticMarkup(
    <FindingDetails row={row} dismiss={() => {}} disabled={false} />,
  );
  const visible = html.split("<details")[0];
  assertStringIncludes(visible, "Open Plex");
  assertStringIncludes(visible, "tt123");
  assertStringIncludes(visible, "tt456");
  assertStringIncludes(visible, "The TMDB ID matches, but the IMDb IDs differ.");
  assertEquals(visible.includes(">TMDB</th>"), false);
  assertEquals(visible.includes("Example (2014).mkv"), false);
  assertStringIncludes(visible, "Saved evidence from an earlier audit");
});
Deno.test("ambiguous matches cannot push the next step below an unbounded comparison", () => {
  const row = finding();
  row.evidence.matches = Array.from(
    { length: 31 },
    (_, i) => ({
      ratingKey: String(i),
      title: `Candidate ${i}`,
      tmdb: ["12"],
      imdb: [],
      paths: [],
      exact: false,
    }),
  );
  const html = renderToStaticMarkup(
    <FindingDetails row={row} dismiss={() => {}} disabled={false} />,
  );
  const visible = html.split("<details")[0];
  assertStringIncludes(visible, "Showing 3 of 31 matches");
  assertEquals((visible.match(/class="missing-match-link"/g) ?? []).length, 3);
  assertStringIncludes(html, "Candidate 30");
});
