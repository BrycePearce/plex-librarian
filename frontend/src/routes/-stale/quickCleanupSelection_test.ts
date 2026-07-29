import { assertEquals } from "@std/assert";
import { selectedQuickCleanupKeys, updateQuickCleanupExclusions } from "./quickCleanupSelection.ts";

Deno.test("quick cleanup defaults new recommendations on while preserving exclusions", () => {
  const excluded = updateQuickCleanupExclusions(new Set<string>(), ["two"], true);

  assertEquals(
    selectedQuickCleanupKeys(["one", "two", "three"], excluded),
    new Set(["one", "three"]),
  );
  assertEquals(
    selectedQuickCleanupKeys(["two", "three", "four"], excluded),
    new Set(["three", "four"]),
  );
});

Deno.test("quick cleanup can explicitly restore excluded recommendations", () => {
  const excluded = updateQuickCleanupExclusions(new Set(["one", "two"]), ["two"], false);
  assertEquals(selectedQuickCleanupKeys(["one", "two"], excluded), new Set(["two"]));
});
