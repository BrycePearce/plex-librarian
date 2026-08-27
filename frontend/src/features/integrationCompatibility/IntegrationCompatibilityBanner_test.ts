import { assertEquals } from "@std/assert";
import type { IntegrationCompatibilityCheck } from "@plex-librarian/shared/types.ts";
import { globalCompatibilityWarnings } from "./IntegrationCompatibilityBanner.tsx";

function check(
  status: IntegrationCompatibilityCheck["status"],
): IntegrationCompatibilityCheck {
  return {
    key: status,
    instanceId: 1,
    kind: "sonarr",
    name: "TV",
    version: "5.0.0.0",
    apiVersion: "v3",
    status,
    message: null,
  };
}

Deno.test("global compatibility warnings exclude future and unreachable versions", () => {
  const checks = [
    check("compatible"),
    check("unverified"),
    check("unreachable"),
    check("limited"),
    check("incompatible"),
  ];

  assertEquals(
    globalCompatibilityWarnings(checks).map((result) => result.status),
    ["limited", "incompatible"],
  );
});
