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
        'download_file_delete_attempts',
        'items_server_tmdb_id_idx',
        'items_server_tvdb_id_idx',
        'qbittorrent_instances',
        'qbittorrent_instances_server_url_unique',
        'torrent_delete_attempts',
        'user_play_observations_session_idx'
      ) ORDER BY name
    `);
    assertEquals(
      objects.values().flat(),
      [
        'arr_delete_attempts',
        'arr_instances_server_type_url_unique',
        'arr_path_mappings',
        'arr_path_mappings_unique',
        'download_file_delete_attempts',
        'items_server_tmdb_id_idx',
        'items_server_tvdb_id_idx',
        'qbittorrent_instances',
        'qbittorrent_instances_server_url_unique',
        'torrent_delete_attempts',
        'user_play_observations_session_idx',
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
