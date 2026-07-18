import { assert, assertEquals, assertRejects } from '@std/assert';
import { resolve } from '@std/path';
import type { PlexRawMetadata } from '../../integrations/plex/types.ts';

const testDirectory = await Deno.makeTempDir();
const testDbPath = resolve(testDirectory, 'deletion-worker.db');
Deno.env.set('DB_PATH', testDbPath);

const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(testDbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const {
  cancelDeletionOperation,
  DeletionConflictError,
  enqueueDeletionOperation,
  getDeletionOperation,
  retryDeletionOperation,
  runDeletionWorkerOnceForTest,
  setAutomaticDeletionWorkerForTest,
} = await import('./service.ts');
const { recoverInterruptedDeletionWork } = await import('./recovery.ts');
const { ensureDeletionTarget } = await import('./workflow.ts');
const { orphanRootIdentity } = await import('../mediaDeletion/hardlinks.ts');
const { runLibrarySync } = await import('../sync/service.ts');
const { resolveActiveServer } = await import('../../integrations/plex/index.ts');

const live = new Map<string, PlexRawMetadata>();
let loseDeleteResponse = false;
let coordinatedRatingKey: string | null = null;
let arrPresent = false;
let arrDeleteCount = 0;
let qbitPresent = false;
let qbitDeleteCount = 0;
const torrentHash = 'a'.repeat(40);
const wholeDeleteOrder: string[] = [];
setAutomaticDeletionWorkerForTest(false);

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname === '/identity') {
    return Promise.resolve(Response.json({ MediaContainer: { machineIdentifier: 'machine-1' } }));
  }
  if (url.pathname === '/status/sessions') {
    return Promise.resolve(Response.json({ MediaContainer: { Metadata: [] } }));
  }
  if (url.pathname === '/library/sections/movies/all') {
    const metadata = [...live.values()].filter((item) => item.type === 'movie');
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  if (url.pathname === '/status/sessions/history/all') {
    return Promise.resolve(Response.json({ MediaContainer: { Metadata: [], totalSize: 0 } }));
  }
  if (url.hostname === 'plex.tv' && url.pathname === '/api/v2/user') {
    return Promise.resolve(Response.json({ id: 1, username: 'owner' }));
  }
  if (url.hostname === 'plex.tv' && url.pathname === '/api/users') {
    return Promise.resolve(new Response('<MediaContainer />'));
  }
  if (url.pathname === '/accounts') {
    return Promise.resolve(Response.json({ MediaContainer: { Account: [] } }));
  }
  if (url.hostname === 'radarr') {
    if (url.pathname === '/api/v3/movie') {
      return Promise.resolve(
        Response.json(
          arrPresent ? [{ id: 7, title: 'Coordinated movie', path: '/library/Coordinated' }] : [],
        ),
      );
    }
    if (url.pathname === '/api/v3/moviefile') {
      return Promise.resolve(Response.json([{ relativePath: 'movie.mkv', size: 100_000 }]));
    }
    if (url.pathname === '/api/v3/extrafile') return Promise.resolve(Response.json([]));
    if (url.pathname === '/api/v3/history/movie') {
      return Promise.resolve(Response.json([{
        id: 1,
        eventType: 'downloadFolderImported',
        downloadId: torrentHash,
        data: { droppedPath: '/downloads/release/movie.mkv' },
      }]));
    }
    if (url.pathname === '/api/v3/history') {
      return Promise.resolve(Response.json({ totalRecords: 1, records: [{ movieId: 7 }] }));
    }
    if (url.pathname === '/api/v3/movie/7' && init?.method === 'DELETE') {
      arrDeleteCount++;
      arrPresent = false;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
  }
  if (url.hostname === 'qbit') {
    if (url.pathname === '/api/v2/app/version') return Promise.resolve(new Response('5.1.2'));
    if (url.pathname === '/api/v2/torrents/info') {
      return Promise.resolve(Response.json(
        qbitPresent
          ? [{
            hash: torrentHash,
            name: 'Release',
            size: 100_000,
            content_path: '/downloads/release',
            save_path: '/downloads',
          }]
          : [],
      ));
    }
    if (url.pathname === '/api/v2/torrents/files') {
      return Promise.resolve(Response.json([{ name: 'release/movie.mkv', size: 100_000 }]));
    }
    if (url.pathname === '/api/v2/torrents/delete' && init?.method === 'POST') {
      qbitDeleteCount++;
      qbitPresent = false;
      return Promise.resolve(new Response(null, { status: 200 }));
    }
  }
  if (url.pathname.match(/^\/library\/sections\/[^/]+\/refresh$/)) {
    if (!arrPresent && coordinatedRatingKey) live.delete(coordinatedRatingKey);
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  const mediaDelete = url.pathname.match(/^\/library\/metadata\/([^/]+)\/media\/(\d+)$/);
  if (mediaDelete && init?.method === 'DELETE') {
    const ratingKey = decodeURIComponent(mediaDelete[1]);
    const mediaId = Number(mediaDelete[2]);
    const item = live.get(ratingKey);
    if (!item?.Media?.some((media) => media.id === mediaId)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    item.Media = item.Media.filter((media) => media.id !== mediaId);
    if (loseDeleteResponse) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  const metadata = url.pathname.match(/^\/library\/metadata\/([^/]+)$/);
  if (metadata) {
    const ratingKey = decodeURIComponent(metadata[1]);
    const item = live.get(ratingKey);
    if (init?.method === 'DELETE') {
      if (!item) return Promise.resolve(new Response(null, { status: 404 }));
      wholeDeleteOrder.push(ratingKey);
      live.delete(ratingKey);
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    return Promise.resolve(
      item
        ? Response.json({ MediaContainer: { Metadata: [item] } })
        : new Response(null, { status: 404 }),
    );
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}) as typeof fetch;

withTransaction((client) => {
  client.prepare(
    "INSERT INTO servers (id, machine_identifier, name, url, access_token, last_connected_at) VALUES (1, 'machine-1', 'Test Plex', 'http://plex', 'token', 1)",
  ).run();
  client.prepare("INSERT INTO settings (id, client_id, active_server_id) VALUES (1, 'test', 1)")
    .run();
  client.prepare(
    "INSERT INTO libraries (server_id, key, title, type, synced_at) VALUES (1, 'movies', 'Movies', 'movie', 1)",
  ).run();
  client.prepare(
    "INSERT INTO libraries (server_id, key, title, type, synced_at) VALUES (1, 'shows', 'Shows', 'show', 1)",
  ).run();
});

function reset(): void {
  loseDeleteResponse = false;
  coordinatedRatingKey = null;
  arrPresent = false;
  arrDeleteCount = 0;
  qbitPresent = false;
  qbitDeleteCount = 0;
  wholeDeleteOrder.length = 0;
  live.clear();
  withTransaction((client) => {
    for (
      const table of [
        'media_version_reservations',
        'deletion_targets',
        'deletion_operations',
        'media_removals',
        'events',
        'torrent_delete_attempts',
        'download_file_delete_attempts',
        'arr_delete_attempts',
        'item_media_versions',
        'episode_media_versions',
        'seasons',
        'items',
        'arr_library_mappings',
        'arr_path_mappings',
        'qbittorrent_instances',
        'arr_instances',
      ]
    ) client.exec(`DELETE FROM ${table}`);
  });
}

function addMovie(ratingKey: string, mediaIds = [11, 12], tmdbId: number | null = null): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO items (server_id, rating_key, library_key, title, type, file_size, tmdb_id, updated_at) VALUES (1, ?, 'movies', ?, 'movie', 100, ?, 1)",
    ).run(ratingKey, `Movie ${ratingKey}`, tmdbId);
    for (const mediaId of mediaIds) {
      client.prepare(
        "INSERT INTO item_media_versions (server_id, media_id, item_rating_key, library_key, file_size, updated_at) VALUES (1, ?, ?, 'movies', 50, 1)",
      ).run(mediaId, ratingKey);
    }
  });
  live.set(ratingKey, {
    ratingKey,
    title: `Movie ${ratingKey}`,
    type: 'movie',
    librarySectionID: 'movies',
    Guid: tmdbId === null ? [] : [{ id: `tmdb://${tmdbId}` }],
    Media: mediaIds.map((id) => ({ id, Part: [{ size: 50_000 }] })),
  });
}

function configureRadarr(withQbit = false): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO arr_instances (id, server_id, type, name, url, api_key, created_at, updated_at) VALUES (1, 1, 'radarr', 'Radarr', 'http://radarr', 'key', 1, 1)",
    ).run();
    client.prepare(
      "INSERT INTO arr_library_mappings (server_id, library_key, arr_instance_id, add_import_exclusion) VALUES (1, 'movies', 1, 1)",
    ).run();
    if (withQbit) {
      client.prepare(
        "INSERT INTO qbittorrent_instances (id, server_id, name, url, username, password, created_at, updated_at) VALUES (1, 1, 'qBittorrent', 'http://qbit', '', '', 1, 1)",
      ).run();
    }
  });
}

function addEpisode(): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO items (server_id, rating_key, library_key, title, type, file_size, tvdb_id, updated_at) VALUES (1, 'show-1', 'shows', 'Example Show', 'show', 100, 20, 1)",
    ).run();
    client.prepare(
      "INSERT INTO seasons (server_id, rating_key, show_rating_key, library_key, season_index, title, file_size, updated_at) VALUES (1, 'season-1', 'show-1', 'shows', 1, 'Season 1', 100, 1)",
    ).run();
    for (const mediaId of [21, 22]) {
      client.prepare(
        "INSERT INTO episode_media_versions (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key, library_key, episode_title, episode_index, season_index, file_size, updated_at) VALUES (1, ?, 'episode-1', 'season-1', 'show-1', 'shows', 'Pilot', 1, 1, 40, 1)",
      ).run(mediaId);
    }
  });
  live.set('show-1', {
    ratingKey: 'show-1',
    title: 'Example Show',
    type: 'show',
    librarySectionID: 'shows',
    Guid: [{ id: 'tvdb://20' }],
  });
  live.set('episode-1', {
    ratingKey: 'episode-1',
    title: 'Pilot',
    type: 'episode',
    librarySectionID: 'shows',
    grandparentRatingKey: 'show-1',
    parentRatingKey: 'season-1',
    parentIndex: 1,
    index: 1,
    Media: [21, 22].map((id) => ({ id, Part: [{ size: 40_000 }] })),
  });
}

async function enqueueVersion(ratingKey: string, mediaId = 11): Promise<string> {
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'movie_version',
    payload: { ratingKey, mediaIds: [mediaId] },
    targets: [{
      kind: 'movie_version',
      key: `${ratingKey}:${mediaId}`,
      title: `Movie ${ratingKey}`,
      logicalSize: 50,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey,
        mediaId,
        selectedMediaIds: [mediaId],
        title: `Movie ${ratingKey}`,
        type: 'movie',
        tmdbId: null,
        tvdbId: null,
        fileSize: 50,
        videoResolution: null,
        bitrate: null,
        videoCodec: null,
        container: null,
        deleteFromArr: false,
      },
      reservation: { mediaKind: 'movie', mediaId, ratingKey },
    }],
  });
  return result.operationId;
}

async function enqueueWhole(ratingKey: string): Promise<string> {
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'whole_item',
    payload: { ratingKey, mode: 'plex-only' },
    targets: [{
      kind: 'whole_item',
      key: ratingKey,
      title: `Movie ${ratingKey}`,
      logicalSize: 100,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey,
        title: `Movie ${ratingKey}`,
        type: 'movie',
        tmdbId: null,
        tvdbId: null,
        mode: 'plex-only',
      },
    }],
  });
  return result.operationId;
}

async function enqueueCoordinated(
  ratingKeys: string[],
  cleanupDownloads = false,
): Promise<string> {
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'whole_item',
    payload: { ratingKeys, mode: 'coordinated', cleanupDownloads },
    targets: ratingKeys.map((ratingKey) => ({
      kind: 'whole_item' as const,
      key: ratingKey,
      title: `Movie ${ratingKey}`,
      logicalSize: 100,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey,
        title: `Movie ${ratingKey}`,
        type: 'movie',
        tmdbId: 10,
        tvdbId: null,
        mode: 'coordinated',
        cleanupDownloads,
        selectedRatingKeys: ratingKeys,
      },
    })),
  });
  return result.operationId;
}

async function enqueueEpisode(): Promise<string> {
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'shows',
    kind: 'episode_version',
    payload: { ratingKey: 'episode-1', mediaIds: [21] },
    targets: [{
      kind: 'episode_version',
      key: 'episode-1:21',
      title: 'Example Show — Pilot',
      logicalSize: 40,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'shows',
        ratingKey: 'episode-1',
        mediaId: 21,
        selectedMediaIds: [21],
        title: 'Example Show — Pilot',
        type: 'episode',
        tmdbId: null,
        tvdbId: 20,
        fileSize: 40,
        videoResolution: null,
        bitrate: null,
        videoCodec: null,
        container: null,
        showTitle: 'Example Show',
        episodeTitle: 'Pilot',
        showRatingKey: 'show-1',
        seasonRatingKey: 'season-1',
        seasonIndex: 1,
        episodeIndex: 1,
        deleteFromArr: false,
      },
      reservation: { mediaKind: 'episode', mediaId: 21, ratingKey: 'episode-1' },
    }],
  });
  return result.operationId;
}

async function settle(): Promise<void> {
  await runDeletionWorkerOnceForTest();
  await Promise.resolve();
}

Deno.test('deletion worker converges direct Plex version deletion atomically', async () => {
  reset();
  addMovie('movie-ok');
  const operationId = await enqueueVersion('movie-ok');
  await settle();
  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM item_media_versions WHERE server_id = 1 AND item_rating_key = ?',
      ).value<[number]>('movie-ok')?.[0]
    ),
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    0,
  );
});

Deno.test('whole-item deletion keeps its projection until Plex absence is confirmed', async () => {
  reset();
  addMovie('whole-ok');
  const operationId = await enqueueWhole('whole-ok');
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM items WHERE rating_key = ?').value<[number]>(
        'whole-ok',
      )?.[0]
    ),
    1,
  );
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM items WHERE rating_key = ?').value<[number]>(
        'whole-ok',
      )?.[0]
    ),
    0,
  );
});

Deno.test('target finalization atomically finalizes its parent operation', async () => {
  reset();
  addMovie('atomic-parent');
  const operationId = await enqueueWhole('atomic-parent');
  const target = withTransaction((client) => {
    const row = client.prepare(
      'SELECT t.id, t.operation_id, o.server_id, t.target_kind, t.target_key, t.snapshot, t.logical_size FROM deletion_targets t JOIN deletion_operations o ON o.id = t.operation_id WHERE t.operation_id = ?',
    ).value<[number, string, number, 'whole_item', string, string, number | null]>(operationId)!;
    client.prepare("UPDATE deletion_targets SET status = 'running' WHERE id = ?").run(row[0]);
    client.prepare("UPDATE deletion_operations SET status = 'running' WHERE id = ?").run(
      operationId,
    );
    return {
      id: row[0],
      operationId: row[1],
      serverId: row[2],
      targetKind: row[3],
      targetKey: row[4],
      snapshot: row[5],
      logicalSize: row[6],
    };
  });

  // Invoke the workflow directly. There is deliberately no worker-level aggregate
  // refresh after this call, so the assertion proves finalization is self-contained.
  await ensureDeletionTarget(target);

  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM events WHERE type = 'deletion.completed' AND payload LIKE ?",
      ).value<[number]>(`%${operationId}%`)?.[0]
    ),
    1,
  );
});

Deno.test('whole-item replay finalizes when Plex already confirms absence', async () => {
  reset();
  addMovie('whole-absent');
  live.delete('whole-absent');
  const operationId = await enqueueWhole('whole-absent');
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM items WHERE rating_key = ?').value<[number]>(
        'whole-absent',
      )?.[0]
    ),
    0,
  );
});

Deno.test('coordinated whole-item deletion converges through Radarr before local finalization', async () => {
  reset();
  configureRadarr();
  addMovie('arr-movie', [11, 12], 10);
  coordinatedRatingKey = 'arr-movie';
  arrPresent = true;
  const operationId = await enqueueCoordinated(['arr-movie']);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(arrDeleteCount, 1);
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM items WHERE rating_key = ?').value<[number]>(
        'arr-movie',
      )?.[0]
    ),
    0,
  );
});

Deno.test('coordinated deletion executes verified qBittorrent cleanup before Radarr', async () => {
  reset();
  configureRadarr(true);
  addMovie('qbit-movie', [11, 12], 10);
  coordinatedRatingKey = 'qbit-movie';
  arrPresent = true;
  qbitPresent = true;
  const operationId = await enqueueCoordinated(['qbit-movie'], true);
  await settle();
  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(qbitDeleteCount, 1);
  assertEquals(arrDeleteCount, 1);
});

Deno.test({
  name: 'coordinated replay recognizes a durably attempted orphan file already absent',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    reset();
    configureRadarr();
    addMovie('orphan-movie', [11, 12], 10);
    coordinatedRatingKey = 'orphan-movie';
    arrPresent = true;
    const downloadRoot = await Deno.makeTempDir();
    try {
      const root = await orphanRootIdentity(downloadRoot);
      const localPath = resolve(downloadRoot, 'release', 'movie.mkv');
      withTransaction((client) => {
        client.prepare(
          "INSERT INTO arr_path_mappings (arr_instance_id, kind, arr_path, local_path) VALUES (1, 'download', '/downloads', ?)",
        ).run(downloadRoot);
        client.prepare(
          'INSERT INTO download_file_delete_attempts (server_id, rating_key, local_path, root_path, root_device, root_inode, started_at) VALUES (1, ?, ?, ?, ?, ?, 1)',
        ).run('orphan-movie', localPath, downloadRoot, root.rootDevice, root.rootInode);
      });
      const operationId = await enqueueCoordinated(['orphan-movie'], true);
      await settle();
      const operation = getDeletionOperation(operationId, 1);
      assertEquals(operation?.status, 'completed', JSON.stringify(operation));
      assertEquals(arrDeleteCount, 1);
    } finally {
      await Deno.remove(downloadRoot, { recursive: true });
    }
  },
});

Deno.test('episode-version deletion converges and updates show and season rollups', async () => {
  reset();
  addEpisode();
  const operationId = await enqueueEpisode();
  await settle();
  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM episode_media_versions WHERE episode_rating_key = ?',
      ).value<[number]>('episode-1')?.[0]
    ),
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT file_size FROM seasons WHERE rating_key = ?',
      ).value<[number]>('season-1')?.[0]
    ),
    60,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT file_size FROM items WHERE rating_key = ?',
      ).value<[number]>('show-1')?.[0]
    ),
    60,
  );
});

Deno.test('multi-target operation processes every target in ordinal order', async () => {
  reset();
  addMovie('batch-a');
  addMovie('batch-b', [31, 32]);
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'whole_item',
    payload: { ratingKeys: ['batch-a', 'batch-b'], mode: 'plex-only' },
    targets: ['batch-a', 'batch-b'].map((ratingKey) => ({
      kind: 'whole_item' as const,
      key: ratingKey,
      title: `Movie ${ratingKey}`,
      logicalSize: 100,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey,
        title: `Movie ${ratingKey}`,
        type: 'movie',
        tmdbId: null,
        tvdbId: null,
        mode: 'plex-only',
      },
    })),
  });
  await settle();
  assertEquals(getDeletionOperation(result.operationId, 1)?.status, 'completed');
  assertEquals(wholeDeleteOrder, ['batch-a', 'batch-b']);
});

Deno.test('multi-version batch replays sequentially while earlier selected versions are absent', async () => {
  reset();
  addMovie('version-batch', [11, 12, 13]);
  const selectedMediaIds = [11, 12];
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'movie_version',
    payload: { ratingKey: 'version-batch', mediaIds: selectedMediaIds },
    targets: selectedMediaIds.map((mediaId) => ({
      kind: 'movie_version' as const,
      key: `version-batch:${mediaId}`,
      title: 'Movie version-batch',
      logicalSize: 50,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey: 'version-batch',
        mediaId,
        selectedMediaIds,
        title: 'Movie version-batch',
        type: 'movie',
        tmdbId: null,
        tvdbId: null,
        fileSize: 50,
        videoResolution: null,
        bitrate: null,
        videoCodec: null,
        container: null,
        deleteFromArr: false,
      },
      reservation: { mediaKind: 'movie' as const, mediaId, ratingKey: 'version-batch' },
    })),
  });
  await settle();
  const operation = getDeletionOperation(result.operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT media_id FROM item_media_versions WHERE item_rating_key = ? ORDER BY media_id',
      ).values('version-batch')
    ),
    [[13]],
  );
});

Deno.test('lost destructive response retains projection and reservation until replay confirms absence', async () => {
  reset();
  addMovie('movie-replay');
  loseDeleteResponse = true;
  const operationId = await enqueueVersion('movie-replay');
  await settle();
  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'waiting_retry', JSON.stringify(operation));
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM item_media_versions WHERE server_id = 1 AND media_id = 11',
      ).value<[number]>()?.[0]
    ),
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    1,
  );

  loseDeleteResponse = false;
  withTransaction((client) =>
    client.prepare(
      "UPDATE deletion_targets SET next_retry_at = 0 WHERE operation_id = ? AND status = 'waiting_retry'",
    ).run(operationId)
  );
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM item_media_versions WHERE server_id = 1 AND media_id = 11',
      ).value<[number]>()?.[0]
    ),
    0,
  );
});

Deno.test('terminal validation failure stays visible and retains the version reservation', async () => {
  reset();
  addMovie('movie-drift');
  live.get('movie-drift')!.title = 'Different movie';
  const operationId = await enqueueVersion('movie-drift');
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM events WHERE type = 'deletion.completed' AND payload LIKE ?",
      ).value<[number]>(`%${operationId}%`)?.[0]
    ),
    1,
  );
});

Deno.test('sync preserves a needs-attention version projection until manual retry finalizes it', async () => {
  reset();
  addMovie('sync-recovery');
  addMovie('sync-survivor', [31, 32]);
  loseDeleteResponse = true;
  const operationId = await enqueueVersion('sync-recovery');
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'waiting_retry');

  // Model transient retry exhaustion after Plex already committed the deletion.
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET status = 'needs_attention', next_retry_at = NULL WHERE operation_id = ?",
    ).run(operationId);
    client.prepare(
      "UPDATE deletion_operations SET status = 'needs_attention', next_retry_at = NULL WHERE id = ?",
    ).run(operationId);
  });
  loseDeleteResponse = false;

  const active = await resolveActiveServer();
  await runLibrarySync(active.client, active.serverId, 'movies');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM item_media_versions WHERE server_id = 1 AND media_id = 11',
      ).value<[number]>()?.[0]
    ),
    1,
  );

  assertEquals(retryDeletionOperation(operationId, 1), true);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    0,
  );
});

Deno.test('sync preserves a needs-attention whole-item projection until manual retry', async () => {
  reset();
  addMovie('whole-sync-recovery');
  addMovie('whole-sync-survivor', [31, 32]);
  const operationId = await enqueueWhole('whole-sync-recovery');
  live.delete('whole-sync-recovery');
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET status = 'needs_attention' WHERE operation_id = ?",
    ).run(operationId);
    client.prepare(
      "UPDATE deletion_operations SET status = 'needs_attention' WHERE id = ?",
    ).run(operationId);
  });

  const active = await resolveActiveServer();
  await runLibrarySync(active.client, active.serverId, 'movies');
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM items WHERE server_id = 1 AND rating_key = ?')
        .value<[number]>('whole-sync-recovery')?.[0]
    ),
    1,
  );

  assertEquals(retryDeletionOperation(operationId, 1), true);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
});

Deno.test('manual retry cannot create two active operations for one library', async () => {
  reset();
  addMovie('old-failure');
  live.get('old-failure')!.title = 'Different movie';
  const oldOperationId = await enqueueVersion('old-failure');
  await settle();
  assertEquals(getDeletionOperation(oldOperationId, 1)?.status, 'needs_attention');

  addMovie('new-work', [31, 32]);
  const newOperationId = await enqueueVersion('new-work', 31);
  assertEquals(getDeletionOperation(newOperationId, 1)?.status, 'queued');
  assertEquals(retryDeletionOperation(oldOperationId, 1), false);
});

Deno.test('new whole-item deletion cannot overlap a version target needing attention', async () => {
  reset();
  addMovie('recovery-overlap');
  live.get('recovery-overlap')!.title = 'Different movie';
  const operationId = await enqueueVersion('recovery-overlap');
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');

  await assertRejects(
    () => enqueueWhole('recovery-overlap'),
    DeletionConflictError,
    'retry it from Activity first',
  );
});

Deno.test('startup recovery requeues a running target from the beginning', async () => {
  reset();
  addMovie('movie-recover');
  const operationId = await enqueueVersion('movie-recover');
  withTransaction((client) => {
    client.prepare("UPDATE deletion_targets SET status = 'running' WHERE operation_id = ?").run(
      operationId,
    );
    client.prepare("UPDATE deletion_operations SET status = 'running' WHERE id = ?").run(
      operationId,
    );
    recoverInterruptedDeletionWork(client, 123);
    assertEquals(
      client.prepare('SELECT status FROM deletion_targets WHERE operation_id = ?').value(
        operationId,
      ),
      ['queued'],
    );
  });
});

Deno.test('cancellation releases only reservations for targets that never started', async () => {
  reset();
  addMovie('movie-cancel');
  const operationId = await enqueueVersion('movie-cancel');
  withTransaction((client) => {
    client.prepare("UPDATE deletion_targets SET status = 'queued' WHERE operation_id = ?").run(
      operationId,
    );
  });
  assert(cancelDeletionOperation(operationId, 1));
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'cancelled');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    0,
  );
});
