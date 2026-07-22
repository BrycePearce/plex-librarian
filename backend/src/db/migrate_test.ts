import { Database } from '@db/sqlite';
import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';
import { runMigrations } from './migrate.ts';

const migrationsDir = resolve(import.meta.dirname!, '../../drizzle');

function runMigrationSql(sqlite: Database, sqlText: string): void {
  for (const statement of sqlText.split('--> statement-breakpoint').map((sql) => sql.trim())) {
    if (statement) sqlite.exec(statement);
  }
}

Deno.test('full migration chain creates current tables, columns, and indexes', async () => {
  const directory = await Deno.makeTempDir();
  const path = resolve(directory, 'librarian.db');
  try {
    await runMigrations(path, migrationsDir);
    const sqlite = new Database(path);
    const objects = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'index') AND name IN (
        'arr_delete_attempts',
        'arr_instances_server_type_url_unique',
        'arr_path_mappings',
        'arr_path_mappings_unique',
        'deletion_operations',
        'deletion_operations_request_unique',
        'deletion_targets',
        'download_file_delete_attempts',
        'items_server_tmdb_id_idx',
        'items_server_tvdb_id_idx',
        'media_removals',
        'media_removals_operation_target_unique',
        'media_version_reservations',
        'media_version_reservations_rating_idx',
        'qbittorrent_instances',
        'qbittorrent_instances_server_url_unique',
        'seerr_instances',
        'seerr_instances_server_url_unique',
        'seerr_request_season_sync_stage',
        'seerr_request_seasons',
        'seerr_request_sync_stage',
        'torrent_delete_attempts',
        'user_play_observations_session_idx',
        'user_season_activity',
        'user_season_activity_account_show_idx'
      ) ORDER BY name
    `);
    assertEquals(
      objects.values().flat(),
      [
        'arr_delete_attempts',
        'arr_instances_server_type_url_unique',
        'arr_path_mappings',
        'arr_path_mappings_unique',
        'deletion_operations',
        'deletion_operations_request_unique',
        'deletion_targets',
        'download_file_delete_attempts',
        'items_server_tmdb_id_idx',
        'items_server_tvdb_id_idx',
        'media_removals',
        'media_removals_operation_target_unique',
        'media_version_reservations',
        'media_version_reservations_rating_idx',
        'qbittorrent_instances',
        'qbittorrent_instances_server_url_unique',
        'seerr_instances',
        'seerr_instances_server_url_unique',
        'seerr_request_season_sync_stage',
        'seerr_request_seasons',
        'seerr_request_sync_stage',
        'torrent_delete_attempts',
        'user_play_observations_session_idx',
        'user_season_activity',
        'user_season_activity_account_show_idx',
      ],
    );
    objects.finalize();
    const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list('arr_delete_attempts')");
    // Two composite foreign keys contribute two PRAGMA rows each, plus the
    // single-column Arr-instance foreign key.
    assertEquals(foreignKeys.values().length, 5);
    foreignKeys.finalize();
    const observationColumns = sqlite.prepare("PRAGMA table_info('user_play_observations')");
    assertEquals(
      observationColumns.values().map((column) => column[1]).filter((name) =>
        name === 'source' || name === 'session_key' || name === 'rating_key'
      ),
      ['source', 'session_key', 'rating_key'],
    );
    observationColumns.finalize();
    const targetColumns = sqlite.prepare("PRAGMA table_info('deletion_targets')");
    assertEquals(
      targetColumns.values().map((column) => column[1]).includes('ambiguous'),
      false,
    );
    targetColumns.finalize();
    const requestColumns = sqlite.prepare("PRAGMA table_info('seerr_requests')");
    assertEquals(
      requestColumns.values().map((column) => column[1]).filter((name) =>
        name === 'media_type' || name === 'availability_observed_at' ||
        name === 'availability_observed_sync_at'
      ),
      ['media_type', 'availability_observed_at', 'availability_observed_sync_at'],
    );
    requestColumns.finalize();
    sqlite.close();
  } finally {
    // @db/sqlite's native Windows handle can outlive close() briefly; the OS temp
    // directory will clean that disposable fixture without making the test flaky.
    if (Deno.build.os !== 'windows') await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('0032 consolidates duplicate Arr instances without dropping mappings', async () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE libraries (
      server_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      PRIMARY KEY (server_id, key)
    );
    CREATE TABLE items (
      server_id INTEGER NOT NULL,
      rating_key TEXT NOT NULL,
      library_key TEXT NOT NULL,
      type TEXT NOT NULL,
      tmdb_id INTEGER,
      tvdb_id INTEGER,
      PRIMARY KEY (server_id, rating_key)
    );
    CREATE TABLE arr_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      server_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE arr_library_mappings (
      server_id INTEGER NOT NULL,
      library_key TEXT NOT NULL,
      arr_instance_id INTEGER NOT NULL,
      add_import_exclusion INTEGER NOT NULL,
      PRIMARY KEY (server_id, library_key, arr_instance_id),
      FOREIGN KEY (arr_instance_id) REFERENCES arr_instances(id) ON DELETE CASCADE
    );
    INSERT INTO libraries VALUES (1, 'movies');
    INSERT INTO arr_instances VALUES
      (1, 1, 'radarr', 'old', 'http://radarr:7878', 'old-key', 1, 1),
      (2, 1, 'radarr', 'new', 'http://radarr:7878', 'new-key', 2, 2);
    INSERT INTO arr_library_mappings VALUES
      (1, 'movies', 1, 0),
      (1, 'movies', 2, 1);
  `);

  runMigrationSql(
    sqlite,
    await Deno.readTextFile(resolve(migrationsDir, '0032_sticky_alex_wilder.sql')),
  );

  assertEquals(sqlite.prepare('SELECT id, api_key FROM arr_instances').values(), [[2, 'new-key']]);
  assertEquals(
    sqlite.prepare(
      'SELECT arr_instance_id, add_import_exclusion FROM arr_library_mappings',
    ).values(),
    [[2, 1]],
  );
  sqlite.close();
});

Deno.test('0043 backfills request types and initializes season-scoped evidence', async () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE servers (id INTEGER PRIMARY KEY);
    CREATE TABLE libraries (
      type TEXT NOT NULL,
      history_synced_at INTEGER
    );
    CREATE TABLE seerr_instances (
      id INTEGER PRIMARY KEY,
      requests_synced_at INTEGER
    );
    CREATE TABLE items (
      server_id INTEGER NOT NULL,
      rating_key TEXT NOT NULL,
      type TEXT NOT NULL,
      PRIMARY KEY (server_id, rating_key)
    );
    CREATE TABLE seerr_requests (
      server_id INTEGER NOT NULL,
      seerr_instance_id INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      rating_key TEXT,
      available_at INTEGER,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (seerr_instance_id, request_id)
    );
    INSERT INTO servers VALUES (1);
    INSERT INTO libraries VALUES ('movie', 100), ('show', 100), ('artist', 100);
    INSERT INTO seerr_instances VALUES (10, 100);
    INSERT INTO items VALUES (1, 'movie-1', 'movie'), (1, 'show-1', 'show');
    INSERT INTO seerr_requests VALUES
      (1, 10, 1, 'movie-1', 50, 100),
      (1, 10, 2, 'show-1', NULL, 100),
      (1, 10, 3, NULL, 70, 100);
  `);

  runMigrationSql(
    sqlite,
    await Deno.readTextFile(resolve(migrationsDir, '0043_melodic_proteus.sql')),
  );

  assertEquals(
    sqlite.prepare('SELECT request_id, media_type FROM seerr_requests ORDER BY request_id')
      .values(),
    [[1, 'movie'], [2, 'tv'], [3, null]],
  );
  assertEquals(
    sqlite.prepare(
      `SELECT request_id, available_at, availability_observed_at,
              availability_observed_sync_at
       FROM seerr_requests ORDER BY request_id`,
    ).values(),
    [[1, null, 50, 100], [2, null, null, null], [3, null, 70, 100]],
  );
  sqlite.prepare(
    'INSERT INTO seerr_request_seasons (seerr_instance_id, request_id, season_number) VALUES (?, ?, ?)',
  ).run(10, 2, 0);
  assertEquals(sqlite.prepare('SELECT season_number FROM seerr_request_seasons').values(), [[0]]);
  assertEquals(sqlite.prepare('SELECT requests_synced_at FROM seerr_instances').values(), [[null]]);
  assertEquals(
    sqlite.prepare('SELECT type, history_synced_at FROM libraries ORDER BY type').values(),
    [['artist', 100], ['movie', null], ['show', null]],
  );
  sqlite.close();
});
