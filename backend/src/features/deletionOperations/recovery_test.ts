import { Database } from '@db/sqlite';
import { assertEquals } from '@std/assert';
import { recoverInterruptedDeletionWork } from './recovery.ts';

Deno.test('startup requeues running targets for full replay', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE deletion_operations (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, next_retry_at INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE deletion_targets (
      id INTEGER PRIMARY KEY, status TEXT NOT NULL, next_retry_at INTEGER, updated_at INTEGER NOT NULL
    );
    INSERT INTO deletion_operations VALUES ('op', 'running', 50, 1);
    INSERT INTO deletion_targets VALUES (1, 'running', 50, 1);
    INSERT INTO deletion_targets VALUES (2, 'running', 50, 1);
  `);

  recoverInterruptedDeletionWork(sqlite, 100);

  assertEquals(
    sqlite.prepare('SELECT status, next_retry_at, updated_at FROM deletion_operations').value(),
    [
      'queued',
      null,
      100,
    ],
  );
  assertEquals(
    sqlite.prepare(
      'SELECT status, next_retry_at, updated_at FROM deletion_targets ORDER BY id',
    ).values(),
    [
      ['queued', null, 100],
      ['queued', null, 100],
    ],
  );
  sqlite.close();
});

Deno.test('startup preserves management holds and reconciles safe reservation terminals', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE deletion_operations (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, next_retry_at INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE deletion_targets (
      id INTEGER PRIMARY KEY, status TEXT NOT NULL, next_retry_at INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE radarr_movie_reservations (
      target_id INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO deletion_operations VALUES ('op', 'running', NULL, 1);
    INSERT INTO deletion_targets VALUES (1, 'running', NULL, 1);
    INSERT INTO deletion_targets VALUES (2, 'needs_attention', NULL, 1);
    INSERT INTO deletion_targets VALUES (3, 'completed', NULL, 1);
    INSERT INTO radarr_movie_reservations VALUES (1, 'reserved', 1);
    INSERT INTO radarr_movie_reservations VALUES (2, 'management_hold', 1);
    INSERT INTO radarr_movie_reservations VALUES (3, 'reserved', 1);
  `);

  recoverInterruptedDeletionWork(sqlite, 100);

  assertEquals(
    sqlite.prepare(
      'SELECT target_id, state, updated_at FROM radarr_movie_reservations ORDER BY target_id',
    ).values(),
    [[1, 'reserved', 100], [2, 'management_hold', 1]],
  );
  sqlite.close();
});
