import { assertEquals } from "@std/assert";
import type { MediaVersion } from "./api.ts";
import { needsTechnicalDetailRefresh } from "./mediaVersion.ts";

function version(streamDetailsAvailable: boolean): MediaVersion {
  return { streamDetailsAvailable } as MediaVersion;
}

Deno.test("technical detail refresh runs when any duplicate version lacks streams", () => {
  assertEquals(
    needsTechnicalDetailRefresh([version(true), version(false)]),
    true,
  );
  assertEquals(needsTechnicalDetailRefresh([version(true), version(true)]), false);
});
