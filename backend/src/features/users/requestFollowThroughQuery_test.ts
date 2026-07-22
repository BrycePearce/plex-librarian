import { type BindValue, Database } from '@db/sqlite';
import { assertEquals } from '@std/assert';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from '../../db/schema.ts';
import { queryRequestFollowThrough } from './requestFollowThroughQuery.ts';

function createFixture() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE seerr_instances (
      id INTEGER PRIMARY KEY,
      server_id INTEGER NOT NULL,
      requests_synced_at INTEGER,
      requests_sync_error TEXT
    );
    CREATE TABLE seerr_requests (
      server_id INTEGER NOT NULL,
      seerr_instance_id INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      account_id INTEGER,
      rating_key TEXT,
      media_type TEXT,
      request_status INTEGER NOT NULL,
      available_at INTEGER,
      availability_estimated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE seerr_request_seasons (
      seerr_instance_id INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL
    );
    CREATE TABLE user_item_activity (
      server_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      rating_key TEXT NOT NULL,
      last_viewed_at INTEGER NOT NULL
    );
    CREATE TABLE user_season_activity (
      server_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      show_rating_key TEXT NOT NULL,
      season_number INTEGER NOT NULL,
      last_viewed_at INTEGER NOT NULL
    );
  `);

  const database = drizzle(
    (query, params, method) => {
      const statement = sqlite.prepare(query);
      try {
        const bound = params as BindValue[];
        if (method === 'run') {
          statement.run(...bound);
          return Promise.resolve({ rows: [] });
        }
        const rows = statement.values(...bound);
        return Promise.resolve({ rows: method === 'get' ? rows.slice(0, 1) : rows });
      } finally {
        statement.finalize();
      }
    },
    { schema },
  );
  return { sqlite, database };
}

Deno.test('request follow-through query keeps eligibility, scope, and watch boundaries aligned', async () => {
  const { sqlite, database } = createFixture();
  try {
    sqlite.exec(`
      INSERT INTO seerr_instances VALUES
        (1, 1, 1000, NULL),
        (2, 1, NULL, 'refresh failed'),
        (3, 2, 1000, NULL);

      INSERT INTO seerr_requests VALUES
        (1, 1, 1, 10, 'movie-at-start', 'movie', 2, 100, 0),
        (1, 1, 2, 10, 'estimated-unwatched', 'movie', 5, 200, 1),
        (1, 1, 3, 10, 'multi-season-show', 'tv', 2, 300, 0),
        (1, 1, 4, 10, 'unknown-show-scope', 'tv', 2, 400, 0),
        (1, 1, 5, 10, NULL, 'movie', 2, 500, 0),
        (1, 1, 6, 10, 'inside-grace', 'movie', 2, 901, 0),
        (1, 1, 7, 10, 'at-cutoff', 'movie', 2, 900, 0),
        (1, 1, 8, 10, 'missing-type', NULL, 2, 600, 0),
        (1, 1, 9, 10, 'rejected', 'movie', 1, 700, 0),
        (1, 1, 10, 11, 'estimated-watched', 'movie', 2, 250, 1),
        (1, 1, 11, NULL, NULL, 'movie', 2, 500, 0),
        (1, 1, 12, NULL, NULL, 'movie', 2, 99, 0),
        (2, 3, 1, NULL, NULL, 'movie', 2, 500, 0);

      INSERT INTO seerr_request_seasons VALUES
        (1, 3, 0),
        (1, 3, 2);

      INSERT INTO user_item_activity VALUES
        (1, 10, 'movie-at-start', 100),
        (1, 10, 'at-cutoff', 899),
        (1, 11, 'estimated-watched', 250);

      INSERT INTO user_season_activity VALUES
        (1, 10, 'multi-season-show', 0, 300),
        (1, 10, 'multi-season-show', 1, 999);
    `);

    const result = await queryRequestFollowThrough({
      serverId: 1,
      accountIds: [10, 11],
      windowStart: 100,
      graceCutoff: 900,
    }, database);

    assertEquals(result.statsByAccount.get(10), {
      eligibleRequestCount: 4,
      watchedRequestCount: 2,
      recentRequestCount: 1,
      estimatedAvailabilityCount: 1,
      uncertainAvailabilityOutcomeCount: 1,
      unmatchedMediaRequestCount: 1,
      unknownRequestScopeCount: 2,
    });
    assertEquals(result.statsByAccount.get(11), {
      eligibleRequestCount: 1,
      watchedRequestCount: 1,
      recentRequestCount: 0,
      estimatedAvailabilityCount: 1,
      uncertainAvailabilityOutcomeCount: 0,
      unmatchedMediaRequestCount: 0,
      unknownRequestScopeCount: 0,
    });
    assertEquals(result.health, {
      connectionCount: 2,
      successfulSyncCount: 1,
      failedSyncCount: 1,
      unmatchedUserRequestCount: 1,
    });
  } finally {
    sqlite.close();
  }
});

Deno.test('request follow-through query skips account aggregation for an empty roster', async () => {
  const { sqlite, database } = createFixture();
  try {
    sqlite.exec(`
      INSERT INTO seerr_instances VALUES (1, 1, 1000, NULL);
      INSERT INTO seerr_requests VALUES
        (1, 1, 1, NULL, NULL, 'movie', 2, 100, 0);
    `);

    const result = await queryRequestFollowThrough({
      serverId: 1,
      accountIds: [],
      windowStart: 100,
      graceCutoff: 900,
    }, database);

    assertEquals(result.statsByAccount.size, 0);
    assertEquals(result.health, {
      connectionCount: 1,
      successfulSyncCount: 1,
      failedSyncCount: 0,
      unmatchedUserRequestCount: 1,
    });
  } finally {
    sqlite.close();
  }
});
