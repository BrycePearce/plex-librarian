import type { SqliteClient } from '../../db/index.ts';
import type { PlexHistoryEntry } from '../../integrations/plex/index.ts';

// SQLite stages aggregates instead of retaining the library's history in JS memory.
// Each walk owns its table, including when different libraries sync concurrently.
export class HistoryCounts {
  private readonly table = `history_counts_${crypto.randomUUID().replaceAll('-', '')}`;

  constructor(private readonly client: SqliteClient) {
    client.exec(`CREATE TEMP TABLE ${this.table} (
      rating_key TEXT NOT NULL,
      season_number INTEGER NOT NULL,
      plays INTEGER NOT NULL,
      PRIMARY KEY (rating_key, season_number)
    )`);
  }

  addPage(page: PlexHistoryEntry[]): void {
    const stmt = this.client.prepare(`INSERT INTO ${this.table} VALUES (?, ?, 1)
      ON CONFLICT(rating_key, season_number) DO UPDATE SET plays = plays + 1`);
    try {
      for (const entry of page) {
        if (!entry.viewedAt) continue;
        const key = entry.grandparentKey
          ? entry.grandparentKey.match(/(\d+)\/?$/)?.[1]
          : entry.ratingKey;
        if (!key) continue;
        stmt.run(key, -1);
        if (entry.grandparentKey && entry.parentIndex != null) {
          stmt.run(key, Number(entry.parentIndex));
        }
      }
    } finally {
      stmt.finalize();
    }
  }

  // Publish only after the complete walk succeeds. Metadata counts and history can
  // overlap, so take the larger count rather than adding them (or adding on replay).
  publish(serverId: number, libraryKey: string): void {
    for (
      const [table, key, season] of [
        ['items', 'rating_key', '-1'],
        ['seasons', 'show_rating_key', 'seasons.season_index'],
      ]
    ) {
      const stmt = this.client.prepare(`UPDATE ${table}
        SET view_count = max(coalesce(view_count, 0), coalesce((
          SELECT plays FROM ${this.table} h
          WHERE h.rating_key = ${table}.${key} AND h.season_number = ${season}
        ), 0))
        WHERE server_id = ? AND library_key = ?`);
      try {
        stmt.run(serverId, libraryKey);
      } finally {
        stmt.finalize();
      }
    }
  }

  dispose(): void {
    this.client.exec(`DROP TABLE ${this.table}`);
  }
}
