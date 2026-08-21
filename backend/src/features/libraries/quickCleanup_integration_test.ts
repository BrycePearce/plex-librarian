import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';

const testDirectory = await Deno.makeTempDir();
const testDbPath = resolve(testDirectory, 'quick-cleanup.db');
Deno.env.set('DB_PATH', testDbPath);

const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(testDbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const {
  analyzeStaleQuickCleanup,
  isStaleQuickCleanupCandidate,
  staleQuickCleanupActiveProtection,
  validateStaleQuickCleanupSelection,
} = await import('./quickCleanup.ts');

const NOW = 2_000_000_000;
const DAY = 86_400;
const OLD = NOW - 366 * DAY;
const RECENT = NOW - 30 * DAY;

withTransaction((client) => {
  client.prepare(
    "INSERT INTO servers (id, machine_identifier, name, url, access_token, last_connected_at) VALUES (1, 'machine', 'Plex', 'http://plex', 'token', 1)",
  ).run();
  client.prepare(
    "INSERT INTO libraries (server_id, key, title, type, synced_at, history_synced_at) VALUES (1, 'movies', 'Movies', 'movie', ?, ?)",
  ).run(NOW, NOW);
  const insertItem = client.prepare(
    `INSERT INTO items
      (server_id, rating_key, library_key, title, type, added_at, last_viewed_at,
       file_size, updated_at)
     VALUES (1, ?, 'movies', ?, 'movie', ?, ?, ?, ?)`,
  );
  insertItem.run('never', 'Never watched', OLD - DAY, null, 100, NOW);
  insertItem.run('dormant', 'Long dormant', OLD, OLD, 200, NOW);
  insertItem.run('recent', 'Recently watched', OLD, RECENT, 500, NOW);
  insertItem.run('unknown-age', 'Unknown age', null, null, 600, NOW);
  insertItem.run('duplicate', 'Duplicate', OLD, null, 700, NOW);
  insertItem.run('requested', 'Recently requested', OLD, null, 800, NOW);
  insertItem.run('suspicious-time', 'Suspicious timestamp', 2021, null, 900, NOW);
  const insertVersion = client.prepare(
    `INSERT INTO item_media_versions
      (server_id, media_id, item_rating_key, library_key, file_size, updated_at)
     VALUES (1, ?, 'duplicate', 'movies', 350, ?)`,
  );
  insertVersion.run(1, NOW);
  insertVersion.run(2, NOW);
  client.prepare(
    "INSERT INTO seerr_instances (id, server_id, name, url, api_key, created_at, updated_at) VALUES (1, 1, 'Seerr', 'http://seerr', 'key', ?, ?)",
  ).run(NOW, NOW);
  client.prepare(
    `INSERT INTO seerr_requests
      (server_id, seerr_instance_id, request_id, rating_key, media_type, request_status,
       media_status, requested_at, availability_estimated, synced_at)
     VALUES (1, 1, 1, 'requested', 'movie', 2, 5, ?, 0, ?)`,
  ).run(RECENT, NOW);
});

Deno.test('quick cleanup recommends only inactive single-version titles without recent requests', () => {
  const analysis = analyzeStaleQuickCleanup(1, 'movies', 365, NOW);
  assertEquals(analysis?.eligible, true);
  assertEquals(analysis?.candidateTotal, 2);
  assertEquals(analysis?.candidateFileSize, 300);
  assertEquals(analysis?.duplicateProtectedCount, 1);
  assertEquals(analysis?.recentRequestProtectedCount, 1);
  assertEquals(
    analysis?.candidates.map(({ ratingKey, reason }) => ({ ratingKey, reason })),
    [
      { ratingKey: 'dormant', reason: 'long-dormant' },
      { ratingKey: 'never', reason: 'never-watched' },
    ],
  );
  assertEquals(
    analyzeStaleQuickCleanup(1, 'movies', 365, NOW, [], 'fileSize', 'asc')
      ?.candidates.map(({ ratingKey }) => ratingKey),
    ['never', 'dormant'],
  );
  assertEquals(
    analyzeStaleQuickCleanup(1, 'movies', 365, NOW, [], 'inactiveSince', 'desc')
      ?.candidates.map(({ ratingKey }) => ratingKey),
    ['never', 'dormant'],
  );
  assertEquals(
    analyzeStaleQuickCleanup(1, 'movies', 365, NOW, [], 'inactiveSince', 'asc')
      ?.candidates.map(({ ratingKey }) => ratingKey),
    ['dormant', 'never'],
  );
  assertEquals(
    staleQuickCleanupActiveProtection(
      1,
      'movies',
      365,
      new Set(['never', 'dormant', 'duplicate', 'requested']),
      NOW,
    ),
    {
      ratingKeys: new Set(['never', 'dormant']),
      count: 2,
      fileSize: 300,
      unknownSizeCount: 0,
    },
  );
  assertEquals(isStaleQuickCleanupCandidate(1, 'movies', 365, 'never', NOW), true);
  assertEquals(isStaleQuickCleanupCandidate(1, 'movies', 365, 'suspicious-time', NOW), false);

  withTransaction((client) => {
    const insertVersion = client.prepare(
      `INSERT INTO item_media_versions
        (server_id, media_id, item_rating_key, library_key, file_size, updated_at)
       VALUES (1, ?, 'never', 'movies', 50, ?)`,
    );
    insertVersion.run(3, NOW);
    insertVersion.run(4, NOW);
  });
  assertEquals(isStaleQuickCleanupCandidate(1, 'movies', 365, 'never', NOW), false);

  withTransaction((client) => {
    client.prepare(
      `INSERT INTO seerr_requests
        (server_id, seerr_instance_id, request_id, rating_key, media_type, request_status,
         media_status, requested_at, availability_estimated, synced_at)
       VALUES (1, 1, 2, 'dormant', 'movie', 1, 1, ?, 0, ?)`,
    ).run(RECENT, NOW);
  });
  assertEquals(isStaleQuickCleanupCandidate(1, 'movies', 365, 'dormant', NOW), true);
  withTransaction((client) => {
    client.prepare(
      'UPDATE seerr_requests SET request_status = 2 WHERE seerr_instance_id = 1 AND request_id = 2',
    ).run();
  });
  assertEquals(isStaleQuickCleanupCandidate(1, 'movies', 365, 'dormant', NOW), false);

  withTransaction((client) => {
    const insertItem = client.prepare(
      `INSERT INTO items
        (server_id, rating_key, library_key, title, type, added_at, last_viewed_at,
         file_size, updated_at)
       VALUES (1, ?, 'movies', ?, 'movie', ?, null, ?, ?)`,
    );
    for (let index = 0; index <= 200; index++) {
      const suffix = String(index).padStart(3, '0');
      insertItem.run(`bulk-${suffix}`, `Bulk ${suffix}`, OLD, 1_000 - index, NOW);
    }
  });
  const smallestFirst = analyzeStaleQuickCleanup(
    1,
    'movies',
    365,
    NOW,
    [],
    'fileSize',
    'asc',
  );
  assertEquals(smallestFirst?.candidateTotal, 201);
  assertEquals(smallestFirst?.candidates.length, 200);
  assertEquals(smallestFirst?.candidates[0]?.ratingKey, 'bulk-199');
  assertEquals(smallestFirst?.candidates.at(-1)?.ratingKey, 'bulk-000');
  assertEquals(
    smallestFirst?.candidates.some(({ ratingKey }) => ratingKey === 'bulk-200'),
    false,
  );
  const inactiveFirst = analyzeStaleQuickCleanup(
    1,
    'movies',
    365,
    NOW,
    [],
    'inactiveSince',
    'desc',
  );
  assertEquals(inactiveFirst?.candidateTotal, 201);
  assertEquals(inactiveFirst?.candidates.length, 200);
  assertEquals(
    inactiveFirst?.candidates.some(({ ratingKey }) => ratingKey === 'bulk-200'),
    false,
  );
  const withoutLargest = analyzeStaleQuickCleanup(
    1,
    'movies',
    365,
    NOW,
    ['bulk-000'],
  );
  assertEquals(withoutLargest?.candidateTotal, 200);
  assertEquals(withoutLargest?.candidates.length, 200);
  assertEquals(withoutLargest?.candidates.at(-1)?.ratingKey, 'bulk-200');
  assertEquals(
    validateStaleQuickCleanupSelection(1, 'movies', 365, ['bulk-200'], NOW)?.has('bulk-200'),
    true,
  );
});

Deno.test('quick cleanup request protection uses its covering lookup index', () => {
  const plan = withTransaction((client) =>
    client.prepare(
      `EXPLAIN QUERY PLAN
       SELECT 1 FROM seerr_requests request
       WHERE request.server_id = ?
         AND request.rating_key = ?
         AND request.request_status IN (2, 5)
         AND request.requested_at >= ?`,
    ).values<unknown[]>(1, 'requested', RECENT)
  );
  assertEquals(
    plan.some((row) =>
      row.some((value) =>
        typeof value === 'string' && value.includes('seerr_requests_cleanup_protection_idx')
      )
    ),
    true,
  );
});
