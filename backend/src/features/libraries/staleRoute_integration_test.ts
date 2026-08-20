import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';
import type {
  IgnoredContentResponse,
  LibrariesResponse,
  StaleResponse,
} from '@plex-librarian/shared/types.ts';

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
  client.prepare(
    `UPDATE libraries
     SET oldest_item_added_at = CAST(strftime('%s', 'now') AS INTEGER) - (9 * 365 * 86400)
     WHERE server_id = 1 AND key = 'movies'`,
  ).run();
  client.prepare(
    `INSERT INTO libraries
      (server_id, key, title, type, synced_at, history_synced_at)
     VALUES (1, 'shows', 'Shows', 'show', 1, 1)`,
  ).run();
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
  client.prepare(
    `INSERT INTO items
      (server_id, rating_key, library_key, title, type, thumb, added_at,
       last_viewed_at, file_size, year, updated_at)
     VALUES (1, 'show-one', 'shows', 'Example Show', 'show', '/show.jpg', 1,
       null, 1000, 2020, 1)`,
  ).run();
  const insertSeason = client.prepare(
    `INSERT INTO seasons
      (server_id, rating_key, show_rating_key, library_key, season_index, title,
       added_at, last_viewed_at, file_size, duration, leaf_count, view_count, updated_at)
     VALUES (1, ?, 'show-one', 'shows', ?, ?, ?, ?, ?, 100, 10, ?, 1)`,
  );
  const now = Math.floor(Date.now() / 1000);
  insertSeason.run('season-1', 1, 'Season 1', 1, null, 600, 0);
  insertSeason.run('season-2', 2, 'Season 2', 1, now, 300, 12);
  insertSeason.run('season-3', 3, 'Season 3', now, null, 100, 0);
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
  assertEquals(page.scope, 'show');
  assertEquals(page.total, 3);
  assertEquals(page.hasMore, true);
  assertEquals(page.items.map((item) => item.ratingKey), ['one', 'two']);

  // Only the literal lowercase value disables counting; older or malformed clients keep
  // the backward-compatible exact total.
  assertEquals((await stale('limit=2&count=FALSE')).total, 3);
});

Deno.test('bare stale requests use and disclose the library-age recommendation', async () => {
  const response = await app.request('/api/libraries/movies/stale?limit=2');
  assertEquals(response.status, 200);
  const page = await response.json() as StaleResponse;
  assertEquals(page.days, 1_095);
  assertEquals(page.automaticStaleDays, 1_095);

  const libraries = await (await app.request('/api/libraries')).json() as LibrariesResponse;
  const movies = libraries.libraries.find((library) => library.key === 'movies');
  assertEquals(movies?.automaticStaleDays, 1_095);
  assertEquals(movies?.automaticQuickCleanupDays, 1_095);
});

Deno.test('TV stale route can return conservative season-scoped results', async () => {
  const response = await app.request(
    '/api/libraries/shows/stale?scope=season&days=365&limit=10',
  );
  assertEquals(response.status, 200);
  const page = await response.json() as StaleResponse;
  assertEquals(page.scope, 'season');
  assertEquals(page.total, 1);
  assertEquals(
    page.items.map((item) => ({
      ratingKey: item.ratingKey,
      title: item.title,
      type: item.type,
      showRatingKey: item.showRatingKey,
      seasonIndex: item.seasonIndex,
    })),
    [{
      ratingKey: 'season-1',
      title: 'Example Show',
      type: 'season',
      showRatingKey: 'show-one',
      seasonIndex: 1,
    }],
  );
});

Deno.test('season scope searches show and season titles and degrades safely for movies', async () => {
  const response = await app.request(
    '/api/libraries/shows/stale?scope=season&days=0&search=Season%202',
  );
  assertEquals(response.status, 200);
  const page = await response.json() as StaleResponse;
  assertEquals(page.items.map((item) => item.ratingKey), ['season-2']);
  const movieResponse = await app.request('/api/libraries/movies/stale?scope=season&days=0');
  assertEquals(movieResponse.status, 200);
  assertEquals(((await movieResponse.json()) as StaleResponse).scope, 'show');
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

Deno.test('ignored content API adds, searches, filters, and restores synced items', async () => {
  const added = await app.request('/api/settings/ignored-content', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ratingKey: 'one' }),
  });
  assertEquals(added.status, 201);

  const ignored = await (await app.request('/api/settings/ignored-content'))
    .json() as IgnoredContentResponse;
  assertEquals(ignored.items.map((item) => item.ratingKey), ['one']);
  const search = await (await app.request('/api/settings/ignored-content/search?q=One'))
    .json() as IgnoredContentResponse;
  assertEquals(search.items[0]?.ignored, true);

  const page = await stale('limit=10');
  assertEquals(page.total, 2);
  assertEquals(page.items.map((item) => item.ratingKey), ['two', 'three']);
  const libraries = await (await app.request('/api/libraries')).json() as LibrariesResponse;
  assertEquals(libraries.libraries[0]?.itemCount, 2);
  assertEquals(libraries.libraries[0]?.totalFileSize, 300);
  assertEquals((await app.request('/api/libraries/movies/movies/one')).status, 404);

  const removed = await app.request('/api/settings/ignored-content/one', { method: 'DELETE' });
  assertEquals(removed.status, 204);
  assertEquals(
    (await app.request('/api/settings/ignored-content/one', { method: 'DELETE' })).status,
    204,
  );
  assertEquals((await stale('limit=10')).total, 3);
});
