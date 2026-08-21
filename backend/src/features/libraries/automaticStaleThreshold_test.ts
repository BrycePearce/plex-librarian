import { assertEquals } from '@std/assert';
import {
  automaticQuickCleanupThresholdDays,
  automaticStaleThresholdDays,
  plausibleItemAddedAt,
} from './automaticStaleThreshold.ts';

const DAY_SECONDS = 86_400;
const YEAR_SECONDS = 365 * DAY_SECONDS;
const NOW = 2_000_000_000;

Deno.test('automatic stale threshold scales with library age and stays bounded', () => {
  assertEquals(automaticStaleThresholdDays(NOW - 2 * YEAR_SECONDS, NOW), 730);
  assertEquals(automaticStaleThresholdDays(NOW - 9 * YEAR_SECONDS, NOW), 1_095);
  assertEquals(automaticStaleThresholdDays(NOW - 15 * YEAR_SECONDS, NOW), 1_825);
  assertEquals(automaticStaleThresholdDays(NOW - 30 * YEAR_SECONDS, NOW), 2_190);
});

Deno.test('automatic stale threshold uses the existing fallback without age evidence', () => {
  assertEquals(automaticStaleThresholdDays(null, NOW), 365);
  assertEquals(automaticStaleThresholdDays(2021, NOW), 365);
  assertEquals(automaticStaleThresholdDays(NOW + 2 * DAY_SECONDS, NOW), 365);
  assertEquals(plausibleItemAddedAt(2021, NOW), false);
  assertEquals(plausibleItemAddedAt(NOW + DAY_SECONDS, NOW), true);
});

Deno.test('automatic Quick Cleanup keeps its three-year safety floor', () => {
  assertEquals(automaticQuickCleanupThresholdDays(NOW - 2 * YEAR_SECONDS, NOW), 1_095);
  assertEquals(automaticQuickCleanupThresholdDays(NOW - 15 * YEAR_SECONDS, NOW), 1_825);
  assertEquals(automaticQuickCleanupThresholdDays(null, NOW), 1_095);
});
