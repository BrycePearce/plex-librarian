import { assertEquals } from '@std/assert';
import { Hono } from 'hono';
import { resolve } from '@std/path';

const testDirectory = await Deno.makeTempDir();
const testDbPath = resolve(testDirectory, 'workflow-ownership.db');
Deno.env.set('DB_PATH', testDbPath);

const { runMigrations } = await import('../../../db/migrate.ts');
await runMigrations(testDbPath, resolve(import.meta.dirname!, '../../../../drizzle'));
const { withTransaction } = await import('../../../db/index.ts');
const duplicatesRoute = (await import('../../duplicates/listRoute.ts')).default;
const librariesRoute = (await import('../../libraries/route.ts')).default;
const deletionOperationsRoute = (await import('../route.ts')).default;
const { buildSmartDuplicateAnalysis } = await import('../../duplicates/smartAnalysis.ts');
const { analyzeStaleQuickCleanup, isStaleQuickCleanupCandidate } = await import(
  '../../libraries/quickCleanup.ts'
);

const NOW = 2_000_000_000;
const OLD = NOW - 400 * 86_400;

type Kind = 'whole_item' | 'movie_version' | 'episode_version';
type Status =
  | 'queued'
  | 'needs_attention'
  | 'completed'
  | 'completed_with_warning'
  | 'cancelled';

function insertOperation(
  id: string,
  libraryKey: string,
  kind: Kind,
  status: Status,
  title: string,
  snapshot: Record<string, unknown>,
  phase = 'validating',
): void {
  withTransaction((client) => {
    client.prepare(
      `INSERT INTO deletion_operations
        (id, client_request_id, request_hash, server_id, library_key, kind, status,
         target_count, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?, ?)`,
    ).run(id, id, id, libraryKey, kind, status, NOW, NOW);
    client.prepare(
      `INSERT INTO deletion_targets
        (operation_id, ordinal, target_kind, target_key, title, snapshot, status, phase,
         created_at, updated_at)
       VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, kind, id, title, JSON.stringify(snapshot), status, phase, NOW, NOW);
  });
}

withTransaction((client) => {
  client.prepare(
    "INSERT INTO servers (id, machine_identifier, name, url, access_token, last_connected_at) VALUES (1, 'machine', 'Plex', 'http://plex', 'token', ?)",
  ).run(NOW);
  client.prepare(
    "INSERT INTO settings (id, client_id, active_server_id) VALUES (1, 'test-client', 1)",
  ).run();
  client.prepare(
    "INSERT INTO libraries (server_id, key, title, type, synced_at, history_synced_at) VALUES (1, 'movies', 'Movies', 'movie', ?, ?), (1, 'shows', 'Shows', 'show', ?, ?)",
  ).run(NOW, NOW, NOW, NOW);
  const item = client.prepare(
    `INSERT INTO items
      (server_id, rating_key, library_key, title, type, added_at, file_size, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (
    const [ratingKey, title, size] of [
      ['owned-movie', 'Owned Movie', 1_900],
      ['visible-movie', 'Visible Movie', 1_500],
      ['whole-owned-movie', 'Whole Owned Movie', 1_100],
      ['completed-movie', 'Completed Movie', 900],
      ['warning-owned-movie', 'Warning Owned Movie', 800],
      ['warning-finalized-movie', 'Warning Finalized Movie', 700],
      ['owned-single', 'Owned Single', 400],
    ] as const
  ) {
    item.run(ratingKey, 'movies', title, 'movie', OLD, size, NOW);
  }
  for (
    const [ratingKey, title] of [
      ['owned-show', 'Owned Show'],
      ['visible-show', 'Visible Show'],
      ['whole-owned-show', 'Whole Owned Show'],
    ] as const
  ) {
    item.run(ratingKey, 'shows', title, 'show', OLD, 1_000, NOW);
  }
  const movieVersion = client.prepare(
    `INSERT INTO item_media_versions
      (server_id, media_id, item_rating_key, library_key, width, height, duration, bitrate,
       video_codec, container, audio_codec, audio_channels, audio_streams_json,
       subtitle_streams_json, stream_details_available, file_size, updated_at)
     VALUES (1, ?, ?, 'movies', 1920, 1080, 7200000, 10000, 'h264', 'mkv', 'aac', 2,
             '[]', '[]', 1, ?, ?)`,
  );
  let mediaId = 1;
  for (
    const [ratingKey, sizes] of [
      ['owned-movie', [1_000, 900]],
      ['visible-movie', [800, 700]],
      ['whole-owned-movie', [600, 500]],
      ['completed-movie', [500, 400]],
      ['warning-owned-movie', [450, 350]],
      ['warning-finalized-movie', [400, 300]],
    ] as const
  ) {
    for (const size of sizes) movieVersion.run(mediaId++, ratingKey, size, NOW);
  }
  const season = client.prepare(
    `INSERT INTO seasons
      (server_id, rating_key, show_rating_key, library_key, season_index, title, updated_at)
     VALUES (1, ?, ?, 'shows', 1, 'Season 1', ?)`,
  );
  const episodeVersion = client.prepare(
    `INSERT INTO episode_media_versions
      (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key,
       library_key, episode_title, episode_index, season_index, width, height, duration,
       bitrate, video_codec, container, audio_codec, audio_channels, audio_streams_json,
       subtitle_streams_json, stream_details_available, file_size, updated_at)
     VALUES (1, ?, ?, ?, ?, 'shows', 'Pilot', 1, 1, 1920, 1080, 3600000, 8000,
             'h264', 'mkv', 'aac', 2, '[]', '[]', 1, ?, ?)`,
  );
  for (
    const [show, episode, sizes] of [
      ['owned-show', 'owned-episode', [400, 300]],
      ['visible-show', 'visible-episode', [350, 250]],
      ['whole-owned-show', 'whole-owned-episode', [300, 200]],
    ] as const
  ) {
    const seasonKey = `${show}-season`;
    season.run(seasonKey, show, NOW);
    for (const size of sizes) episodeVersion.run(mediaId++, episode, seasonKey, show, size, NOW);
  }
});

insertOperation('op-owned-movie', 'movies', 'movie_version', 'needs_attention', 'Owned Movie', {
  libraryKey: 'movies',
  ratingKey: 'owned-movie',
  mediaId: 1,
});
insertOperation('op-owned-episode', 'shows', 'episode_version', 'needs_attention', 'Owned Show', {
  libraryKey: 'shows',
  ratingKey: 'owned-episode',
  showRatingKey: 'owned-show',
  mediaId: 13,
});
insertOperation(
  'op-whole-movie',
  'movies',
  'whole_item',
  'needs_attention',
  'Whole Owned Movie',
  { libraryKey: 'movies', ratingKey: 'whole-owned-movie' },
);
insertOperation(
  'op-whole-show',
  'shows',
  'whole_item',
  'needs_attention',
  'Whole Owned Show',
  { libraryKey: 'shows', ratingKey: 'whole-owned-show' },
);
insertOperation('op-owned-single', 'movies', 'whole_item', 'queued', 'Owned Single', {
  libraryKey: 'movies',
  ratingKey: 'owned-single',
});
insertOperation('op-completed', 'movies', 'movie_version', 'completed', 'Completed Movie', {
  libraryKey: 'movies',
  ratingKey: 'completed-movie',
  mediaId: 7,
});
insertOperation(
  'op-warning-owned',
  'movies',
  'movie_version',
  'completed_with_warning',
  'Warning Owned Movie',
  { libraryKey: 'movies', ratingKey: 'warning-owned-movie', mediaId: 9 },
  'plex_reconciliation',
);
insertOperation(
  'op-warning-finalized',
  'movies',
  'movie_version',
  'completed_with_warning',
  'Warning Finalized Movie',
  { libraryKey: 'movies', ratingKey: 'warning-finalized-movie', mediaId: 11 },
  'finalizing',
);

withTransaction((client) => {
  const targetId = client.prepare(
    "SELECT id FROM deletion_targets WHERE operation_id = 'op-owned-movie'",
  ).value<[number]>()![0];
  client.prepare(
    "INSERT INTO media_version_reservations (server_id, media_kind, media_id, rating_key, operation_id, target_id, created_at) VALUES (1, 'movie', 1, 'owned-movie', 'op-owned-movie', ?, ?)",
  ).run(targetId, NOW);
});

const app = new Hono();
app.route('/api/duplicates', duplicatesRoute);
app.route('/api/libraries', librariesRoute);
app.route('/api/deletion-operations', deletionOperationsRoute);

Deno.test('workflow-owned duplicate roots are excluded before totals and pagination', async () => {
  const first = await (await app.request('/api/duplicates?limit=1&offset=0')).json();
  const second = await (await app.request('/api/duplicates?limit=1&offset=1')).json();
  const comparison = await (await app.request(
    '/api/duplicates?comparison=same-profile&limit=20',
  )).json();
  assertEquals(first.total, 4);
  assertEquals(second.total, 4);
  assertEquals(
    [...first.groups, ...second.groups].some((group) =>
      ['owned-movie', 'owned-episode', 'whole-owned-movie', 'whole-owned-episode'].includes(
        group.ratingKey ?? group.episodeRatingKey,
      )
    ),
    false,
  );
  assertEquals(comparison.total, 4);
  assertEquals(
    comparison.groups.map((group: { ratingKey?: string; episodeRatingKey?: string }) =>
      group.ratingKey ?? group.episodeRatingKey
    ).sort(),
    ['completed-movie', 'visible-episode', 'visible-movie', 'warning-finalized-movie'],
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM item_media_versions WHERE item_rating_key = 'owned-movie'",
      ).value<[number]>()![0]
    ),
    2,
  );
});

Deno.test('stale duplicate and smart cleanup queries exclude workflow-owned roots', async () => {
  const movies = await (await app.request(
    '/api/libraries/movies/stale?days=0&duplicatesOnly=true&limit=20',
  )).json();
  const shows = await (await app.request(
    '/api/libraries/shows/stale?days=0&duplicatesOnly=true&limit=20',
  )).json();
  assertEquals(movies.total, 3);
  assertEquals(movies.items.map((item: { ratingKey: string }) => item.ratingKey).sort(), [
    'completed-movie',
    'visible-movie',
    'warning-finalized-movie',
  ]);
  assertEquals(shows.total, 1);
  assertEquals(shows.items[0].ratingKey, 'visible-show');

  const smart = await buildSmartDuplicateAnalysis(1, { movies: true, tv: true });
  assertEquals(
    smart.candidates.map((candidate) => candidate.ratingKey).sort(),
    ['completed-movie', 'visible-episode', 'visible-movie', 'warning-finalized-movie'],
  );
  const quick = analyzeStaleQuickCleanup(1, 'movies', 365, NOW);
  assertEquals(
    quick?.candidates.some((candidate) => candidate.ratingKey === 'owned-single'),
    false,
  );
  assertEquals(isStaleQuickCleanupCandidate(1, 'movies', 365, 'owned-single', NOW), false);
});

Deno.test('current attention listing includes unresolved warnings exactly once', async () => {
  const response = await (await app.request(
    '/api/deletion-operations?attention=true&limit=20&offset=0',
  )).json();
  assertEquals(response.total, 5);
  assertEquals(
    new Set(response.operations.map((operation: { id: string }) => operation.id)).size,
    5,
  );
  assertEquals(
    response.operations.every((operation: { titles: string[] }) => operation.titles.length === 1),
    true,
  );
  assertEquals(
    response.operations.find((operation: { id: string }) => operation.id === 'op-owned-movie')
      ?.retryable,
    true,
  );
  assertEquals(
    response.operations.find((operation: { id: string }) => operation.id === 'op-warning-owned')
      ?.retryable,
    true,
  );
  assertEquals(
    response.operations.some((operation: { id: string }) =>
      operation.id === 'op-warning-finalized'
    ),
    false,
  );
});

Deno.test('dismiss releases recovery ownership but preserves an audit warning', async () => {
  const response = await app.request('/api/deletion-operations/op-owned-movie/dismiss', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ acknowledge: true }),
  });
  assertEquals(response.status, 200);
  const operation = await response.json();
  assertEquals(operation.status, 'completed_with_warning');
  assertEquals(operation.targets[0].status, 'completed_with_warning');
  assertEquals(operation.targets[0].phase, 'finalizing');
  assertEquals(operation.targets[0].warning, 'Dismissed after manual intervention');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = 'op-owned-movie'",
      ).value<[number]>()![0]
    ),
    0,
  );
  const attention = await (await app.request(
    '/api/deletion-operations?attention=true&limit=20&offset=0',
  )).json();
  assertEquals(
    attention.operations.some((entry: { id: string }) => entry.id === 'op-owned-movie'),
    false,
  );
});

Deno.test('finalized audit warnings cannot be rechecked or dismissed', async () => {
  const retry = await app.request('/api/deletion-operations/op-warning-finalized/retry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'all' }),
  });
  assertEquals(retry.status, 409);
  const dismiss = await app.request('/api/deletion-operations/op-warning-finalized/dismiss', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ acknowledge: true }),
  });
  assertEquals(dismiss.status, 409);
});
