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
