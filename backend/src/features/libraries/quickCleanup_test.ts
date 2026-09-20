import { assertEquals } from '@std/assert';
import { parseStaleQuickCleanupDays } from './quickCleanupRules.ts';

Deno.test('quick cleanup accepts only bounded whole-day thresholds', () => {
  assertEquals(parseStaleQuickCleanupDays(180), 180);
  assertEquals(parseStaleQuickCleanupDays('365'), 365);
  assertEquals(parseStaleQuickCleanupDays(3_650), 3_650);
  assertEquals(parseStaleQuickCleanupDays(179), null);
  assertEquals(parseStaleQuickCleanupDays(3_651), null);
  assertEquals(parseStaleQuickCleanupDays(365.5), null);
});
