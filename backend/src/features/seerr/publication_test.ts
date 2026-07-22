import { Database } from '@db/sqlite';
import { assertEquals } from '@std/assert';
import { publishStagedRequestGeneration } from './publication.ts';

Deno.test('staged publication is atomic and retains confirmed missing requests', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE seerr_instances (
      id INTEGER PRIMARY KEY,
      requests_synced_at INTEGER,
      requests_sync_error TEXT
    );
    CREATE TABLE seerr_requests (
      server_id INTEGER NOT NULL,
      seerr_instance_id INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      account_id INTEGER,
      requester_username TEXT,
      requester_email TEXT,
      rating_key TEXT,
      media_type TEXT,
      request_status INTEGER NOT NULL,
      media_status INTEGER NOT NULL,
      requested_at INTEGER NOT NULL,
      available_at INTEGER,
      availability_observed_at INTEGER,
      availability_observed_sync_at INTEGER,
      availability_estimated INTEGER NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (seerr_instance_id, request_id)
    );
    CREATE TABLE seerr_request_seasons (
      seerr_instance_id INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL,
      PRIMARY KEY (seerr_instance_id, request_id, season_number),
      FOREIGN KEY (seerr_instance_id, request_id)
        REFERENCES seerr_requests(seerr_instance_id, request_id) ON DELETE CASCADE
    );
    CREATE TABLE seerr_request_sync_stage (
      seerr_instance_id INTEGER NOT NULL,
      sync_marker INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      server_id INTEGER NOT NULL,
      account_id INTEGER,
      requester_username TEXT,
      requester_email TEXT,
      rating_key TEXT,
      media_type TEXT,
      request_status INTEGER NOT NULL,
      media_status INTEGER NOT NULL,
      requested_at INTEGER NOT NULL,
      available_at INTEGER,
      availability_observed_at INTEGER,
      availability_observed_sync_at INTEGER,
      availability_estimated INTEGER NOT NULL,
      PRIMARY KEY (seerr_instance_id, sync_marker, request_id)
    );
    CREATE TABLE seerr_request_season_sync_stage (
      seerr_instance_id INTEGER NOT NULL,
      sync_marker INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL,
      PRIMARY KEY (seerr_instance_id, sync_marker, request_id, season_number),
      FOREIGN KEY (seerr_instance_id, sync_marker, request_id)
        REFERENCES seerr_request_sync_stage(seerr_instance_id, sync_marker, request_id)
        ON DELETE CASCADE
    );
    INSERT INTO seerr_instances VALUES (1, 100, 'old error');
    INSERT INTO seerr_requests VALUES
      (1, 1, 1, 10, 'user', NULL, 'show', 'tv', 2, 5, 1, 50, NULL, NULL, 1, 100),
      (1, 1, 2, 10, 'user', NULL, 'movie', 'movie', 2, 5, 1, 60, NULL, NULL, 0, 100),
      (1, 1, 3, 10, 'user', NULL, 'pending', 'movie', 2, 3, 1, NULL, NULL, NULL, 0, 100);
    INSERT INTO seerr_request_seasons VALUES (1, 1, 1);
    INSERT INTO seerr_request_sync_stage VALUES
      (1, -200, 1, 1, 10, 'user', NULL, 'show', 'tv', 2, 5, 1, 50, NULL, NULL, 1),
      (1, -200, 4, 1, 10, 'user', NULL, 'new', 'movie', 2, 5, 1, NULL, 70, 100, 1);
    INSERT INTO seerr_request_season_sync_stage VALUES (1, -200, 1, 2);
  `);

  sqlite.transaction(() => publishStagedRequestGeneration(sqlite, 1, -200, 200, 100))();

  assertEquals(
    sqlite.prepare(
      `SELECT request_id, available_at, synced_at
       FROM seerr_requests ORDER BY request_id`,
    ).values(),
    [[1, 50, 200], [2, 60, 100], [4, 70, 200]],
  );
  assertEquals(
    sqlite.prepare('SELECT request_id, season_number FROM seerr_request_seasons').values(),
    [
      [1, 2],
    ],
  );
  assertEquals(
    sqlite.prepare('SELECT requests_synced_at, requests_sync_error FROM seerr_instances').values(),
    [
      [200, null],
    ],
  );
  assertEquals(sqlite.prepare('SELECT count(*) FROM seerr_request_sync_stage').values(), [[0]]);
  assertEquals(sqlite.prepare('SELECT count(*) FROM seerr_request_season_sync_stage').values(), [[
    0,
  ]]);

  sqlite.prepare(
    `INSERT INTO seerr_request_sync_stage VALUES
      (1, -201, 5, 1, 10, 'user', NULL, 'same-second', 'movie', 2, 5, 1,
       NULL, 80, 200, 1)`,
  ).run();
  sqlite.transaction(() => publishStagedRequestGeneration(sqlite, 1, -201, 200, 200))();
  assertEquals(
    sqlite.prepare(
      `SELECT available_at, availability_observed_at, availability_observed_sync_at
       FROM seerr_requests WHERE request_id = 5`,
    ).values(),
    [[null, 80, 200]],
  );
  sqlite.close();
});
