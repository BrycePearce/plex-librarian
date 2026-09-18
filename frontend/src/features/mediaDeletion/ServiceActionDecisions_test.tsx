import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServiceActionDecision } from "../../../../shared/serviceOwnedDeletion.ts";
import { ServiceActionDecisions, serviceActionLabel } from "./ServiceActionDecisions.tsx";

const action: ServiceActionDecision = {
  actionId: "plex:1",
  service: "plex",
  targetId: "1",
  requested: true,
  state: "kept",
  reason: "A retained download shares this entry.",
  evidenceRevision: "revision",
};

Deno.test("episode actions group by service and outcome without hiding pending work", () => {
  const actions = Array.from({ length: 29 }, (_, i) => ({
    ...action,
    actionId: `arr:3:file:${i}`,
    service: "sonarr" as const,
    state: "delete_candidate" as const,
    reason: "Sonarr removes this file.",
    outcome: i < 2 ? "accepted" as const : undefined,
  }));
  const html = renderToStaticMarkup(<ServiceActionDecisions actions={actions} />);
  assertStringIncludes(html, "Sonarr · 2 actions");
  assertStringIncludes(html, "Sonarr · 27 actions");
  assertEquals((html.match(/Sonarr removes this file/g) ?? []).length, 2);
  assertStringIncludes(html, "Awaiting confirmation");
  assertStringIncludes(html, "Requested deletion");
  assertStringIncludes(html, "arr:3:file:28");
});

Deno.test("retained Plex is visible without claiming removal or reclaimed space", () => {
  const html = renderToStaticMarkup(<ServiceActionDecisions actions={[action]} />);
  assertStringIncludes(html, "This media will remain in Plex.");
  assertStringIncludes(html, "Kept");
  assertEquals(html.includes("Service removal confirmed"), false);
  assertEquals(html.includes("reclaimed"), false);
  assertEquals(serviceActionLabel({ ...action, outcome: "succeeded" }), "Kept");
});

Deno.test("API acceptance and uncertainty never render as completed service removal", () => {
  assertEquals(
    serviceActionLabel({ ...action, state: "delete_candidate", outcome: "accepted" }),
    "Awaiting confirmation",
  );
  assertEquals(
    serviceActionLabel({ ...action, state: "delete_candidate", outcome: "uncertain" }),
    "Outcome uncertain",
  );
  assertEquals(serviceActionLabel({ ...action, state: "held" }), "Held");
  assertEquals(serviceActionLabel({ ...action, state: "not_applicable" }), "Not applicable");
});
