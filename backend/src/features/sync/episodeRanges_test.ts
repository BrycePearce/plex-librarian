import { assertEquals } from '@std/assert';
import {
  EpisodeRangeSet,
  MAX_EPISODE_INDEX,
  MAX_MISSING_RANGES,
  MAX_PRESENT_RANGES,
  MAX_SEASON_INDEX,
} from './episodeRanges.ts';

function audit(values: Array<number | null>, season = 1) {
  const set = new EpisodeRangeSet();
  for (const value of values) set.insert(value);
  return set.finish(season);
}

Deno.test('episode ranges merge arbitrary order and ignore duplicates', () => {
  assertEquals(audit([5, 2, 4, 1, 2]), {
    status: 'gaps',
    reason: null,
    firstIndex: 1,
    lastIndex: 5,
    presentCount: 4,
    gapCount: 1,
    gapRanges: [{ start: 3, end: 3 }],
  });
  assertEquals(audit([8, 2, 5, 4, 7, 3, 6]).status, 'ok');
});

Deno.test('episode ranges classify invalid, oversized, excluded, and fragmented numbering', () => {
  assertEquals(audit([1, null]).reason, 'invalid_episode_index');
  assertEquals(audit([1, -1]).reason, 'invalid_episode_index');
  assertEquals(audit([1, 1.5]).reason, 'invalid_episode_index');
  assertEquals(audit([1, Number.MAX_SAFE_INTEGER]).reason, 'episode_index_too_large');
  assertEquals(audit([1, MAX_EPISODE_INDEX + 1]).reason, 'episode_index_too_large');
  assertEquals(audit([1], 0).status, 'excluded');
  assertEquals(audit([1], -1).reason, 'invalid_season_index');
  assertEquals(audit([1], 1.5).reason, 'invalid_season_index');
  assertEquals(audit([1], Number.MAX_SAFE_INTEGER).reason, 'season_index_too_large');
  assertEquals(audit([1], MAX_SEASON_INDEX + 1).reason, 'season_index_too_large');
  const fragmented = Array.from({ length: MAX_PRESENT_RANGES + 1 }, (_, i) => i * 2 + 1);
  assertEquals(audit(fragmented).reason, 'range_limit_exceeded');
});

Deno.test('episode ranges exclude Plex specials without poisoning regular season numbering', () => {
  assertEquals(audit([0, 1, 2, 3]), {
    status: 'ok',
    reason: null,
    firstIndex: 1,
    lastIndex: 3,
    presentCount: 3,
    gapCount: 0,
    gapRanges: [],
  });
  assertEquals(audit([0]), {
    status: 'excluded',
    reason: 'episode_zero_only',
    firstIndex: null,
    lastIndex: null,
    presentCount: null,
    gapCount: null,
    gapRanges: null,
  });
  assertEquals(audit([0, null]).reason, 'invalid_episode_index');
});

Deno.test('episode ranges keep arithmetic and persisted gaps within every bound', () => {
  const widest = audit([1, MAX_EPISODE_INDEX]);
  assertEquals(widest.gapCount, MAX_EPISODE_INDEX - 2);
  assertEquals(widest.gapRanges, [{ start: 2, end: MAX_EPISODE_INDEX - 1 }]);

  const maximallyFragmentedValid = Array.from(
    { length: MAX_PRESENT_RANGES },
    (_, index) => index * 2 + 1,
  );
  const fragmented = audit(maximallyFragmentedValid);
  // The present-range limit makes 255 the largest reachable missing-range projection,
  // which remains below the separately enforced persistence ceiling of 256.
  assertEquals(fragmented.status, 'gaps');
  assertEquals(fragmented.gapRanges?.length, MAX_PRESENT_RANGES - 1);
  assertEquals((fragmented.gapRanges?.length ?? 0) <= MAX_MISSING_RANGES, true);
});

Deno.test('episode ranges never infer leading or trailing gaps', () => {
  const result = audit([2, 3, 4, 5, 6, 7, 8]);
  assertEquals(result.status, 'ok');
  assertEquals(result.firstIndex, 2);
  assertEquals(result.lastIndex, 8);
  assertEquals(result.gapCount, 0);
});
