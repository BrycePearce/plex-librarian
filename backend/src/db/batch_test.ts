import { assertEquals, assertThrows } from '@std/assert';
import { SQLITE_WRITE_BATCH_ROWS, sqliteWriteBatches } from './batch.ts';

Deno.test('maximum Plex fetch window is split into conservative SQLite writes', () => {
  const rows = Array.from({ length: 2_400 }, (_, index) => index);
  const batches = [...sqliteWriteBatches(rows)];

  assertEquals(SQLITE_WRITE_BATCH_ROWS, 500);
  assertEquals(batches.map((batch) => batch.length), [500, 500, 500, 500, 400]);
  assertEquals(batches.flat(), rows);
});

Deno.test('SQLite write batching handles empty input and rejects invalid sizes', () => {
  assertEquals([...sqliteWriteBatches([])], []);
  assertThrows(() => [...sqliteWriteBatches([1], 0)], RangeError);
});
