import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { DeletionSetupLink } from "./DeletionSetupLink.tsx";

Deno.test("storage relationship errors open setup separately and preserve the deletion selection", () => {
  for (
    const reason of [
      "Storage relationship is missing, ambiguous, or has declared aliases for plex:2. Review Media connections.",
      "No storage relationship covers the selected files for plex:2.",
      "Overlapping storage relationships cover the selected files for plex:2.",
      "The storage relationship for plex:2 declares aliases.",
      "Storage relationship for plex:2 needs confirmation after its connection changed.",
    ]
  ) {
    const html = renderToStaticMarkup(<DeletionSetupLink reason={reason} />);
    assertStringIncludes(html, 'href="/settings/sonarr-radarr"');
    assertStringIncludes(html, 'target="_blank"');
    assertStringIncludes(html, "Your selection stays here");
  }
  assertEquals(
    renderToStaticMarkup(<DeletionSetupLink reason="The selected media is playing" />),
    "",
  );
});
