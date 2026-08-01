import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';
import type { StaleResponse } from '@plex-librarian/shared/types.ts';

const testDirectory = await Deno.makeTempDir();
const testDbPath = resolve(testDirectory, 'stale-route.db');
Deno.env.set('DB_PATH', testDbPath);
Deno.env.delete('PLEX_URL');
Deno.env.delete('PLEX_TOKEN');

const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(testDbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');

withTransaction((client) => {
  const insertServer = client.prepare(
    `INSERT INTO servers
      (id, machine_identifier, name, url, access_token, last_connected_at)
     VALUES (?, ?, ?, 'http://plex', 'token', 1)`,
  );
  insertServer.run(1, 'machine-1', 'Active');
  insertServer.run(2, 'machine-2', 'Inactive');
  client.prepare(
    `INSERT INTO settings (id, client_id, active_server_id)
     VALUES (1, 'test-client', 1)
     ON CONFLICT(id) DO UPDATE SET active_server_id = excluded.active_server_id`,
  ).run();
  const insertLibrary = client.prepare(
    `INSERT INTO libraries
      (server_id, key, title, type, synced_at, history_synced_at)
     VALUES (?, 'movies', 'Movies', 'movie', 1, 1)`,
  );
  insertLibrary.run(1);
  insertLibrary.run(2);
  const insertItem = client.prepare(
    `INSERT INTO items
      (server_id, rating_key, library_key, title, type, added_at, last_viewed_at,
       file_size, updated_at)
     VALUES (?, ?, 'movies', ?, 'movie', 1, null, ?, 1)`,
  );
  insertItem.run(1, 'one', 'One', 300);
  insertItem.run(1, 'two', 'Two', 200);
  insertItem.run(1, 'three', 'Three', 100);
  insertItem.run(2, 'foreign', 'Foreign', 1_000);
});

const { createApp } = await import('../../app.ts');
const app = createApp();

async function stale(query: string): Promise<StaleResponse> {
  const response = await app.request(`/api/libraries/movies/stale?days=0&${query}`);
  assertEquals(response.status, 200);
  return await response.json() as StaleResponse;
}

Deno.test('stale route counts by default and returns bounded look-ahead metadata', async () => {
  const page = await stale('limit=2');
  assertEquals(page.total, 3);
  assertEquals(page.hasMore, true);
  assertEquals(page.items.map((item) => item.ratingKey), ['one', 'two']);

  // Only the literal lowercase value disables counting; older or malformed clients keep
  // the backward-compatible exact total.
  assertEquals((await stale('limit=2&count=FALSE')).total, 3);
});

Deno.test('stale route can omit the count without losing hasMore', async () => {
  const lastPage = await stale('limit=2&offset=2&count=false');
  assertEquals(lastPage.total, null);
  assertEquals(lastPage.hasMore, false);
  assertEquals(lastPage.items.map((item) => item.ratingKey), ['three']);

  const firstPage = await stale('limit=2&count=false');
  assertEquals(firstPage.total, null);
  assertEquals(firstPage.hasMore, true);
  assertEquals(firstPage.items.length, 2);
});

Deno.test('stale route keeps an exact total for a past-end direct link', async () => {
  const page = await stale('limit=2&offset=20');
  assertEquals(page.total, 3);
  assertEquals(page.hasMore, false);
  assertEquals(page.items, []);
});
