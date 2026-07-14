// A row-count policy rather than a variable-count calculation on purpose: Drizzle's
// generated statement shape is an implementation detail, while 500 rows leaves ample
// room under @db/sqlite's 32,766-variable limit even as schemas gain columns. Keeping
// this independent from Plex fetch sizes also prevents concurrency tuning from silently
// changing the size of a SQL statement.
export const SQLITE_WRITE_BATCH_ROWS = 500;

export function* sqliteWriteBatches<T>(
  rows: readonly T[],
  batchSize = SQLITE_WRITE_BATCH_ROWS,
): Generator<T[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    yield rows.slice(offset, offset + batchSize);
  }
}
