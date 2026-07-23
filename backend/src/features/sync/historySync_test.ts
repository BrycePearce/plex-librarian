import { Database } from '@db/sqlite';
import { assertEquals, assertThrows } from '@std/assert';
import { applyUserHistoryMaxima, historySeasonNumber } from './historySync.ts';

Deno.test('episode history requires a season number for scoped attribution', () => {
  assertThrows(
    () =>
      historySeasonNumber({
        ratingKey: 'episode-1',
        grandparentKey: '/library/metadata/76749',
        viewedAt: 1_700_000_000,
        accountID: 1,
      }),
    Error,
    'Plex omitted the season number',
  );
});

Deno.test('history season attribution accepts specials and ignores movies', () => {
  assertEquals(
    historySeasonNumber({
      ratingKey: 'episode-1',
      grandparentKey: '/library/metadata/76749',
      parentIndex: 0,
    }),
    0,
  );
  assertEquals(historySeasonNumber({ ratingKey: 'movie-1' }), null);
});

Deno.test('history maxima cannot cross a mapping reassignment', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      server_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      local_account_id INTEGER,
      last_viewed_at INTEGER,
      PRIMARY KEY (server_id, account_id)
    );
    INSERT INTO users VALUES (1, 700, 800, NULL);
  `);

  // The history walk resolved local id 800 to account 700, then an authoritative
  // reconciliation reassigned that id before the walk published its final aggregate.
  sqlite.prepare(
    'UPDATE users SET local_account_id = NULL WHERE server_id = ? AND account_id = ?',
  ).run(1, 700);
  sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(1, 800, 800, null);

  applyUserHistoryMaxima(sqlite, 1, [{
    accountId: 700,
    localAccountId: 800,
    viewedAt: 123,
  }]);

  assertEquals(
    sqlite.prepare(
      'SELECT account_id, last_viewed_at FROM users ORDER BY account_id',
    ).values(),
    [[700, null], [800, null]],
  );
  sqlite.close();
});
