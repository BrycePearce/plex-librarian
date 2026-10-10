import { Database } from '@db/sqlite';
import { assertEquals, assertThrows } from '@std/assert';
import {
  applyUserHistoryMaxima,
  historySeasonNumber,
  SEASON_HISTORY_MAXIMUM_SQL,
} from './historySync.ts';

Deno.test('season history updates probe one show and preserve exact scope and maxima', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE seasons (
      server_id INTEGER, rating_key TEXT, show_rating_key TEXT, season_index INTEGER,
      library_key TEXT, last_viewed_at INTEGER, file_size INTEGER,
      PRIMARY KEY (server_id, rating_key)
    );
    CREATE INDEX seasons_show_idx ON seasons(server_id, show_rating_key);
    CREATE INDEX seasons_library_idx ON seasons(server_id, library_key);
    CREATE INDEX seasons_library_stale_idx ON seasons(server_id, library_key, last_viewed_at);
    CREATE INDEX seasons_library_file_size_idx ON seasons(server_id, library_key, file_size);
    INSERT INTO seasons VALUES
      (1,'missing','show',1,'tv',NULL,100),
      (1,'older','show',1,'tv',50,100),
      (1,'newer','show',1,'tv',200,100),
      (1,'season','show',2,'tv',NULL,100),
      (1,'show','other',1,'tv',NULL,100),
      (1,'library','show',1,'other',NULL,100),
      (2,'server','show',1,'tv',NULL,100);
  `);
  try {
    const params = [100, 1, 'show', 1, 'tv', 100];
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${SEASON_HISTORY_MAXIMUM_SQL}`);
    try {
      const details = plan.values(...params).map((row) => String(row[3])).join('\n');
      assertEquals(
        details.includes('USING INDEX seasons_show_idx (server_id=? AND show_rating_key=?)'),
        true,
      );
    } finally {
      plan.finalize();
    }
    const update = sqlite.prepare(SEASON_HISTORY_MAXIMUM_SQL);
    try {
      update.run(...params);
    } finally {
      update.finalize();
    }
    const rows = sqlite.prepare(
      'SELECT rating_key, last_viewed_at FROM seasons ORDER BY rating_key',
    );
    try {
      assertEquals(rows.values(), [
        ['library', null],
        ['missing', 100],
        ['newer', 200],
        ['older', 100],
        ['season', null],
        ['server', null],
        ['show', null],
      ]);
    } finally {
      rows.finalize();
    }
  } finally {
    sqlite.close();
  }
});

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
