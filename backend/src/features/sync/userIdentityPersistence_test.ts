import { Database } from '@db/sqlite';
import { assertEquals } from '@std/assert';
import { applyConfirmedIdentityMappings } from './userIdentityPersistence.ts';

Deno.test('changing a legacy mapping clears every persisted attribution source', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      server_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      local_account_id INTEGER,
      last_viewed_at INTEGER,
      last_ip TEXT,
      last_player TEXT,
      total_plays INTEGER NOT NULL,
      total_duration INTEGER NOT NULL,
      last_scrobbled_at INTEGER,
      PRIMARY KEY (server_id, account_id)
    );
    CREATE TABLE user_item_activity (server_id INTEGER, account_id INTEGER);
    CREATE TABLE user_season_activity (server_id INTEGER, account_id INTEGER);
    CREATE TABLE user_ip_history (server_id INTEGER, account_id INTEGER);
    CREATE TABLE user_play_observations (server_id INTEGER, account_id INTEGER);

    INSERT INTO users VALUES
      (1, 700, 800, 100, '203.0.113.1', 'TV', 4, 4000, 100),
      (1, 900, NULL, 200, '203.0.113.2', 'Phone', 2, 2000, 200);
    INSERT INTO user_item_activity VALUES (1, 700), (1, 900);
    INSERT INTO user_season_activity VALUES (1, 700), (1, 900);
    INSERT INTO user_ip_history VALUES (1, 700), (1, 900);
    INSERT INTO user_play_observations VALUES (1, 700), (1, 900);
  `);

  sqlite.transaction(() =>
    applyConfirmedIdentityMappings(sqlite, 1, [
      { accountId: 700, previous: 800, next: null },
      { accountId: 900, previous: null, next: 900 },
    ])
  )();

  assertEquals(
    sqlite.prepare(
      `SELECT local_account_id, last_viewed_at, last_ip, last_player,
              total_plays, total_duration, last_scrobbled_at
       FROM users WHERE account_id = 700`,
    ).values(),
    [[null, null, null, null, 0, 0, null]],
  );
  assertEquals(
    sqlite.prepare(
      `SELECT local_account_id, last_viewed_at, last_ip, last_player,
              total_plays, total_duration, last_scrobbled_at
       FROM users WHERE account_id = 900`,
    ).values(),
    [[900, 200, '203.0.113.2', 'Phone', 2, 2000, 200]],
  );

  for (
    const table of [
      'user_item_activity',
      'user_season_activity',
      'user_ip_history',
      'user_play_observations',
    ]
  ) {
    assertEquals(
      sqlite.prepare(`SELECT account_id FROM ${table} ORDER BY account_id`).values(),
      [[900]],
    );
  }
  sqlite.close();
});
