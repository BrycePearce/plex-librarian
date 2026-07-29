import { assertEquals } from "@std/assert";
import {
  formatQuickCleanupInactivity,
  formatQuickCleanupLibraryShare,
} from "./quickCleanupPresentation.ts";

const NOW = 2_000_000_000;
const daysAgo = (days: number) => NOW - days * 86_400;

Deno.test("quick cleanup inactivity shows concrete elapsed time", () => {
  assertEquals(formatQuickCleanupInactivity(daysAgo(12), NOW), "12d inactive");
  assertEquals(formatQuickCleanupInactivity(daysAgo(210), NOW), "7mo inactive");
  assertEquals(formatQuickCleanupInactivity(daysAgo(365 * 3 + 120), NOW), "3y 4mo inactive");
  assertEquals(formatQuickCleanupInactivity(daysAgo(365 * 2), NOW), "2y inactive");
});

Deno.test("quick cleanup reports its share of the library", () => {
  assertEquals(formatQuickCleanupLibraryShare(136, 250), "54%");
  assertEquals(formatQuickCleanupLibraryShare(2, 250), "0.8%");
  assertEquals(formatQuickCleanupLibraryShare(0, 0), "—");
});
