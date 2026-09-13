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
