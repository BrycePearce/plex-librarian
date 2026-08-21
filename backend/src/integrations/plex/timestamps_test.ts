import { assertEquals } from '@std/assert';
import { normalizePlexTimestamp, plausiblePlexTimestamp } from './timestamps.ts';

const NOW = 2_000_000_000;

Deno.test('Plex timestamps reject calendar years and implausible epoch values', () => {
  assertEquals(plausiblePlexTimestamp(2021, NOW), false);
  assertEquals(normalizePlexTimestamp(2021, NOW), null);
  assertEquals(normalizePlexTimestamp('1700000000', NOW), null);
  assertEquals(normalizePlexTimestamp(1_700_000_000.5, NOW), null);
  assertEquals(normalizePlexTimestamp(1_700_000_000, NOW), 1_700_000_000);
  assertEquals(normalizePlexTimestamp(2_100_000_000, NOW), null);
});
