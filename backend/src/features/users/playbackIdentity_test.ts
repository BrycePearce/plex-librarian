import { Database } from '@db/sqlite';
import { assertEquals } from '@std/assert';
import { resolvePlaybackAccountId } from './playbackIdentity.ts';

Deno.test('playback identity resolution is numeric, unique, and observes mapping changes', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      server_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      local_account_id INTEGER,
      PRIMARY KEY (server_id, account_id)
    );
    INSERT INTO users VALUES (1, 700, 700);
  `);

  assertEquals(resolvePlaybackAccountId(sqlite, 1, 700, 'session'), 700);
  assertEquals(resolvePlaybackAccountId(sqlite, 1, 700, 'local'), 700);

  sqlite.prepare(
    'UPDATE users SET local_account_id = ? WHERE server_id = ? AND account_id = ?',
  ).run(701, 1, 700);
  assertEquals(resolvePlaybackAccountId(sqlite, 1, 700, 'local'), 'unmatched');
  assertEquals(resolvePlaybackAccountId(sqlite, 1, 700, 'session'), 700);

  sqlite.prepare('INSERT INTO users VALUES (?, ?, ?)').run(1, 1, 1);
  assertEquals(resolvePlaybackAccountId(sqlite, 1, 1, 'session'), 1);
  sqlite.prepare('INSERT INTO users VALUES (?, ?, ?)').run(1, 900, 1);
  assertEquals(resolvePlaybackAccountId(sqlite, 1, 1, 'session'), 'ambiguous');

  assertEquals(resolvePlaybackAccountId(sqlite, 1, 0, 'local'), 'unmatched');
  assertEquals(resolvePlaybackAccountId(sqlite, 1, -1, 'local'), 'unmatched');
  assertEquals(resolvePlaybackAccountId(sqlite, 1, 1.5, 'local'), 'unmatched');
  sqlite.close();
});
