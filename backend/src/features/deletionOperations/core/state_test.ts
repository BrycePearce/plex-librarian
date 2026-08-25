import { assertEquals } from '@std/assert';
import { Database } from '@db/sqlite';
import { refreshDeletionOperation } from './state.ts';

Deno.test('operation completion preserves verified hardlink totals above 32-bit range', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`
      CREATE TABLE deletion_operations (
        id TEXT PRIMARY KEY, server_id INTEGER NOT NULL, library_key TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, target_count INTEGER NOT NULL,
        completed_count INTEGER NOT NULL DEFAULT 0, warning_count INTEGER NOT NULL DEFAULT 0,
        removal_confirmed_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0,
        logical_size_removed INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER,
        finished_at INTEGER, updated_at INTEGER NOT NULL
      );
      CREATE TABLE deletion_targets (
        operation_id TEXT NOT NULL, status TEXT NOT NULL, removal_confirmed_at INTEGER,
        logical_size INTEGER, next_retry_at INTEGER, snapshot TEXT NOT NULL,
        error TEXT, phase TEXT NOT NULL, storage_outcome TEXT,
        verified_hardlink_data_size INTEGER
      );
      CREATE TABLE events (
        server_id INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO deletion_operations
        (id, server_id, library_key, kind, status, target_count, updated_at)
      VALUES ('operation', 1, 'shows', 'whole_item', 'running', 1, 0);
      INSERT INTO deletion_targets
        (operation_id, status, removal_confirmed_at, logical_size, snapshot, phase,
         storage_outcome, verified_hardlink_data_size)
      VALUES ('operation', 'completed', 1, 10, '{}', 'finalizing', 'verified', 3000000000);
    `);

    refreshDeletionOperation(sqlite, 'operation');
    const payload = JSON.parse(
      sqlite.prepare("SELECT payload FROM events WHERE type = 'deletion.completed'").value<
        [string]
      >()![0],
    );
    assertEquals(payload.verifiedHardlinkDataRemoved, 3_000_000_000);
    assertEquals(payload.verifiedTargetCount, 1);
  } finally {
    sqlite.close();
  }
});
