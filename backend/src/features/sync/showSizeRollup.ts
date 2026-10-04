import type { SqliteClient } from '../../db/index.ts';

// Aggregate once rather than running two correlated SUMs per show. Without
// planner statistics SQLite can choose a library-wide index for those SUMs,
// repeatedly scanning every season in the library for every show.
export function rollupShowSizes(
  client: SqliteClient,
  serverId: number,
  libraryKey: string,
): void {
  const statement = client.prepare(`
    WITH totals AS MATERIALIZED (
      SELECT show_rating_key, SUM(view_count) AS plays, SUM(file_size) AS size
      FROM seasons
      WHERE server_id = ? AND library_key = ?
      GROUP BY show_rating_key
    )
    UPDATE items AS current
    SET view_count = COALESCE(totals.plays, current.view_count),
        file_size = COALESCE(totals.size, current.file_size)
    FROM totals
    WHERE current.server_id = ? AND current.library_key = ? AND current.type = 'show'
      AND current.rating_key = totals.show_rating_key
      AND (current.view_count IS NOT COALESCE(totals.plays, current.view_count)
        OR current.file_size IS NOT COALESCE(totals.size, current.file_size))
  `);
  try {
    statement.run(serverId, libraryKey, serverId, libraryKey);
  } finally {
    statement.finalize();
  }
}
