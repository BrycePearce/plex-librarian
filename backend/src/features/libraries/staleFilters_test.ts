import { assertEquals } from '@std/assert';
import { staleCutoffs } from './staleFilters.ts';

const DAY = 86_400;
const NOW = 2_000 * DAY;

Deno.test('selected inactivity duration applies to never-watched items', () => {
  assertEquals(staleCutoffs(NOW, 1_095, null, 90).unwatchedAddedBefore, NOW - 1_095 * DAY);
});

Deno.test('minimum item age can make never-watched eligibility stricter', () => {
  assertEquals(staleCutoffs(NOW, 90, null, 365).unwatchedAddedBefore, NOW - 365 * DAY);
});

Deno.test('range boundaries retain the requested bucket', () => {
  assertEquals(staleCutoffs(NOW, 365, 730, 90), {
    viewedBefore: NOW - 365 * DAY,
    viewedOnOrAfter: NOW - 730 * DAY,
    unwatchedAddedBefore: NOW - 365 * DAY,
    unwatchedAddedOnOrAfter: NOW - 730 * DAY,
  });
});
