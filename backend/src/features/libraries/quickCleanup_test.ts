import { assertEquals } from '@std/assert';
import { classifyStaleQuickCleanup, parseStaleQuickCleanupDays } from './quickCleanupRules.ts';

const CUTOFF = 1_000_000;

Deno.test('quick cleanup classifies watched and never-watched inactivity conservatively', () => {
  assertEquals(classifyStaleQuickCleanup(CUTOFF - 1, CUTOFF + 1, CUTOFF), 'long-dormant');
  assertEquals(classifyStaleQuickCleanup(null, CUTOFF - 1, CUTOFF), 'never-watched');
  assertEquals(classifyStaleQuickCleanup(CUTOFF, CUTOFF - 1, CUTOFF), null);
  assertEquals(classifyStaleQuickCleanup(null, CUTOFF, CUTOFF), null);
  assertEquals(classifyStaleQuickCleanup(null, null, CUTOFF), null);
});

Deno.test('quick cleanup accepts only bounded whole-day thresholds', () => {
  assertEquals(parseStaleQuickCleanupDays(180), 180);
  assertEquals(parseStaleQuickCleanupDays('365'), 365);
  assertEquals(parseStaleQuickCleanupDays(3_650), 3_650);
  assertEquals(parseStaleQuickCleanupDays(179), null);
  assertEquals(parseStaleQuickCleanupDays(3_651), null);
  assertEquals(parseStaleQuickCleanupDays(365.5), null);
});
