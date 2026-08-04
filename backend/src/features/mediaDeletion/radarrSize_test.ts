import { assertEquals } from '@std/assert';
import { plexProjectedKilobytes, radarrBytesMatchProjectedKilobytes } from './radarrSize.ts';

Deno.test('Radarr size compatibility accepts direct decimal-KB metadata', () => {
  assertEquals(plexProjectedKilobytes(50_000), 50);
  assertEquals(radarrBytesMatchProjectedKilobytes(50_000, 50), true);
});

Deno.test('Radarr size compatibility accepts Plex legacy 32-bit wrapping', () => {
  const bytes = 5_000_000_000;
  const wrappedProjection = Math.round((bytes % 2 ** 32) / 1000);
  assertEquals(radarrBytesMatchProjectedKilobytes(bytes, wrappedProjection), true);
  assertEquals(plexProjectedKilobytes(-294_967_296), 4_000_000);
});

Deno.test('Radarr size compatibility rejects invalid or inconsistent metadata', () => {
  for (const value of [null, '', '50000', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    assertEquals(plexProjectedKilobytes(value), null);
  }
  for (const value of [null, '', '50000', NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    assertEquals(radarrBytesMatchProjectedKilobytes(value, 50), false);
  }
  for (const value of [null, '', '50', NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    assertEquals(radarrBytesMatchProjectedKilobytes(50_000, value), false);
  }
  assertEquals(radarrBytesMatchProjectedKilobytes(50_000, 51), false);
});
