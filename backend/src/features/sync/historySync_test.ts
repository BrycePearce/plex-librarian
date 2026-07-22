import { assertEquals, assertThrows } from '@std/assert';
import { historySeasonNumber } from './historySync.ts';

Deno.test('episode history requires a season number for scoped attribution', () => {
  assertThrows(
    () =>
      historySeasonNumber({
        ratingKey: 'episode-1',
        grandparentKey: '/library/metadata/76749',
        viewedAt: 1_700_000_000,
        accountID: 1,
      }),
    Error,
    'Plex omitted the season number',
  );
});

Deno.test('history season attribution accepts specials and ignores movies', () => {
  assertEquals(
    historySeasonNumber({
      ratingKey: 'episode-1',
      grandparentKey: '/library/metadata/76749',
      parentIndex: 0,
    }),
    0,
  );
  assertEquals(historySeasonNumber({ ratingKey: 'movie-1' }), null);
});
