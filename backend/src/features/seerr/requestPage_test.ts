import { assertEquals, assertInstanceOf, assertThrows } from '@std/assert';
import { RequestPageCoverage, validateRequestPageRecords } from './requestPage.ts';

Deno.test('request pages reject malformed records instead of pruning prior evidence', () => {
  const records = [
    {
      id: 1,
      status: 2,
      createdAt: '2026-01-01T00:00:00Z',
      media: { mediaType: 'movie', tmdbId: 1 },
    },
    { id: 2, status: 2, media: { mediaType: 'movie', tmdbId: 2 } },
  ];
  const error = assertThrows(() => validateRequestPageRecords(records, 100));
  assertInstanceOf(error, Error);
  assertEquals(error.message, 'Seerr returned 1 malformed request record(s) at offset 100');
});

Deno.test('request pages preserve every record after complete validation', () => {
  const records = [{
    id: 1,
    status: 2,
    createdAt: '2026-01-01T00:00:00Z',
    media: { mediaType: 'movie', tmdbId: 1 },
  }];
  assertEquals(validateRequestPageRecords(records, 0), records);
});

Deno.test('short request pages continue until the reported total is covered', () => {
  const coverage = new RequestPageCoverage();
  const records = (start: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: start + index,
    }));
  assertEquals(coverage.accept(records(1, 50), 120, 0), false);
  assertEquals(coverage.accept(records(51, 50), 120, 50), false);
  assertEquals(coverage.accept(records(101, 20), 120, 100), true);
});

Deno.test('request page coverage rejects changing totals and incomplete empty pages', () => {
  const changing = new RequestPageCoverage();
  assertEquals(changing.accept([{ id: 1 }], 2, 0), false);
  assertThrows(() => changing.accept([{ id: 2 }], 3, 1));

  const incomplete = new RequestPageCoverage();
  assertEquals(incomplete.accept([{ id: 1 }], 2, 0), false);
  assertThrows(() => incomplete.accept([], 2, 1));
});

Deno.test('request page coverage rejects a same-count replacement during pagination', () => {
  const coverage = new RequestPageCoverage();
  assertEquals(coverage.accept([{ id: 101 }], 2, 0), false);
  assertEquals(coverage.accept([{ id: 100 }], 2, 1), true);

  assertThrows(
    () => coverage.verifyStableBoundary([{ id: 102 }], 2),
    Error,
    'request ordering changed',
  );
});
