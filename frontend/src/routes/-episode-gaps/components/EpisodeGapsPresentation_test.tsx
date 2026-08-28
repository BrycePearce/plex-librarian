import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { episodeGapFixture, seasonGapFixture } from "../fixtures.ts";
import { EpisodeGapRow } from "./EpisodeGapRow.tsx";
import { SeasonGapRow } from "./SeasonGapRow.tsx";
import { episodeGapsSummaryPresentation } from "../utils/summaryPresentation.ts";

Deno.test("episode and season summaries use scope-specific counts and labels", () => {
  assertEquals(episodeGapsSummaryPresentation(episodeGapFixture, "episode"), {
    missingCount: 31,
    gapContainerCount: 12,
    irregularCount: 2,
    missingNoun: "episodes",
    containerNoun: "seasons",
    irregularNoun: "seasons",
  });
  assertEquals(episodeGapsSummaryPresentation(seasonGapFixture, "season"), {
    missingCount: 1,
    gapContainerCount: 1,
    irregularCount: 1,
    missingNoun: "seasons",
    containerNoun: "shows",
    irregularNoun: "shows",
  });
});

Deno.test("episode and season rows render distinct range vocabulary", () => {
  const episode = episodeGapFixture.rows[0]!;
  const episodeHtml = renderToStaticMarkup(
    <EpisodeGapRow row={episode} sonarrTargets={[]} />,
  );
  assertStringIncludes(episodeHtml, "<strong>2</strong> episodes missing");
  assertStringIncludes(episodeHtml, "inspected E1–E10");
  assertStringIncludes(episodeHtml, "E4");
  assertStringIncludes(episodeHtml, "Episodes 1 through 10; missing episode 4, episode 7");

  const season = seasonGapFixture.rows[0]!;
  const seasonHtml = renderToStaticMarkup(
    <SeasonGapRow row={season} sonarrTargets={[]} />,
  );
  assertStringIncludes(seasonHtml, "<strong>1</strong> season missing");
  assertStringIncludes(seasonHtml, "4 of 5 seasons present · inspected S1–S5");
  assertStringIncludes(seasonHtml, "S3");
  assertStringIncludes(seasonHtml, "Seasons 1 through 5; missing season 3");
});

Deno.test("irregular season rows explain season-numbering metadata", () => {
  const irregular = seasonGapFixture.rows[1]!;
  const html = renderToStaticMarkup(<SeasonGapRow row={irregular} sonarrTargets={[]} />);
  assertStringIncludes(html, "Season numbering needs review");
  assertStringIncludes(html, "Plex returned an invalid season index.");
  assertStringIncludes(html, "Irregular show metadata");
});
