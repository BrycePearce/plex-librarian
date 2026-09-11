import type { DeletionOperation } from '../../../../shared/types.ts';
import { assert, assertEquals } from '@std/assert';
import { resolve } from '@std/path';

const directory = await Deno.makeTempDir();
const database = resolve(directory, 'ordinary-worker.db');
Deno.env.set('DB_PATH', database);
Deno.env.delete('PLEX_URL');
Deno.env.delete('PLEX_TOKEN');
Deno.env.delete('QBITTORRENT_URL');
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(database, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { createApp } = await import('../../app.ts');
const {
  setAutomaticDeletionWorkerForTest,
  runDeletionWorkerOnceForTest,
  getDeletionOperation,
  retryDeletionOperation,
} = await import('./service.ts');
const { clearPlexClientCache } = await import('../../integrations/plex/index.ts');
setAutomaticDeletionWorkerForTest(false);
const app = createApp();
let responseStatus = 200, lost = false, deleteCalls = 0;
let discoverableRoots = false;
let automaticSetup = false;
let arrUnavailable = false;
let arrConnectionTests = 0;
let arrCurrentMedia = false;
let retainedInArrFolder = false;
let retainedSameFile = false;
let playing = false;
let qbRoot = '/data/.torrents/complete';
let qbJobs: Array<
  { hash: string; content_path: string; save_path: string; size: number; total_size: number }
> = [];
let duringDiscovery: (() => void) | undefined;
const file = resolve(directory, 'fixture-media.txt');
await Deno.writeTextFile(file, 'Fixture content retained by the service recycle-bin simulation');
const raw = {
  ratingKey: 'one',
  title: 'Fixture Movie',
  type: 'movie',
  librarySectionID: 'movies',
  Guid: [{ id: 'tmdb://123' }],
  Media: [{ id: 1, Part: [{ file: '/service-only/Fixture/movie.mkv', size: 100 }] }],
};
globalThis.fetch = ((input, init) => {
  const url = new URL(String(input));
  if (automaticSetup && url.hostname === 'arr-setup-fixture.invalid') {
    if (url.pathname === '/api/v3/system/status') arrConnectionTests++;
    if (init?.method && init.method !== 'GET') throw new Error('Unexpected Arr mutation');
    if (arrUnavailable) {
      return Promise.resolve(new Response('Fixture connection unavailable', { status: 401 }));
    }
    const body = url.pathname === '/api/v3/system/status'
      ? { version: '5.0', appName: 'Radarr' }
      : url.pathname === '/api/v3/rootfolder'
      ? [{ id: 1, path: '/data/Movies' }]
      : arrCurrentMedia && url.pathname === '/api/v3/movie'
      ? [{
        id: 7,
        title: 'Fixture Movie',
        tmdbId: 123,
        path: '/data/Movies/Fixture',
        monitored: true,
      }]
      : arrCurrentMedia && url.pathname === '/api/v3/moviefile'
      ? [{ id: 8, relativePath: 'movie.mkv', path: '/data/Movies/Fixture/movie.mkv', size: 100 }]
      : ['/api/v3/remotepathmapping', '/api/v3/movie', '/api/v3/history/movie'].includes(
          url.pathname,
        )
      ? []
      : null;
    if (!body) throw new Error(`Unexpected Arr fixture read: ${url.pathname}`);
    return Promise.resolve(Response.json(body));
  }
  if (automaticSetup && url.hostname === 'qb-setup-fixture.invalid') {
    if (init?.method && init.method !== 'GET') throw new Error('Unexpected QB mutation');
    const change = duringDiscovery;
    duringDiscovery = undefined;
    change?.();
    const response = url.pathname === '/api/v2/app/version'
      ? new Response('v5.0.0')
      : url.pathname === '/api/v2/app/webapiVersion'
      ? new Response('2.11.0')
      : url.pathname === '/api/v2/app/preferences'
      ? Response.json({ save_path: qbRoot })
      : url.pathname === '/api/v2/torrents/categories'
      ? Response.json({})
      : url.pathname === '/api/v2/torrents/info'
      ? Response.json(qbJobs)
      : null;
    if (!response) throw new Error(`Unexpected QB fixture read: ${url.pathname}`);
    return Promise.resolve(response);
  }
  if (url.hostname !== 'ordinary-fixture.invalid') {
    throw new Error('Unexpected external endpoint in fixture');
  }
  if (init?.method === 'DELETE') {
    deleteCalls++;
    if (lost) return Promise.reject(new TypeError('Lost fixture response'));
    return Promise.resolve(new Response(null, { status: responseStatus }));
  }
  const path = url.pathname;
  const body = path === '/identity'
    ? { MediaContainer: { machineIdentifier: 'ordinary-fixture' } }
    : path === '/library/sections'
    ? {
      MediaContainer: {
        Directory: [{
          key: 'movies',
          title: 'Movies',
          type: 'movie',
          ...(discoverableRoots
            ? { Location: [{ id: 1, path: automaticSetup ? '/data/Movies' : '/service-only' }] }
            : {}),
        }],
      },
    }
    : path === '/status/sessions'
    ? { MediaContainer: { Metadata: playing ? [{ ratingKey: raw.ratingKey }] : [] } }
    : path === '/library/sections/movies/all'
    ? {
      MediaContainer: {
        Metadata: [
          raw,
          ...(retainedInArrFolder || retainedSameFile
            ? [{
              ...raw,
              ratingKey: 'retained',
              title: 'Retained movie',
              Media: [{
                id: 2,
                Part: [{
                  file: retainedSameFile
                    ? raw.Media[0].Part[0].file
                    : '/data/Movies/Fixture/other.mkv',
                  size: 100,
                }],
              }],
            }]
            : []),
        ],
        totalSize: retainedInArrFolder || retainedSameFile ? 2 : 1,
      },
    }
    : path === `/library/metadata/${raw.ratingKey}`
    ? { MediaContainer: { Metadata: [raw] } }
    : null;
  if (!body) throw new Error(`Unexpected fixture read: ${path}`);
  return Promise.resolve(Response.json(body));
}) as typeof fetch;

function reset() {
  clearPlexClientCache();
  deleteCalls = 0;
  lost = false;
  responseStatus = 200;
  discoverableRoots = false;
  automaticSetup = false;
  arrUnavailable = false;
  arrConnectionTests = 0;
  arrCurrentMedia = false;
  retainedInArrFolder = false;
  retainedSameFile = false;
  playing = false;
  qbRoot = '/data/.torrents/complete';
  qbJobs = [];
  duringDiscovery = undefined;
  raw.ratingKey = 'one';
  raw.title = 'Fixture Movie';
  raw.Media[0].Part[0].file = '/service-only/Fixture/movie.mkv';
  withTransaction((client) => {
    client.prepare('DELETE FROM host_discovery').run();
    client.prepare('DELETE FROM deletion_operations').run();
    client.prepare('DELETE FROM service_path_roots').run();
    client.prepare('DELETE FROM qbittorrent_instances').run();
    client.prepare('DELETE FROM arr_library_mappings').run();
    client.prepare('DELETE FROM arr_instances').run();
    client.prepare('DELETE FROM settings').run();
    client.prepare('DELETE FROM items').run();
    client.prepare(
      "INSERT OR IGNORE INTO servers (id,machine_identifier,name,url,access_token,last_connected_at) VALUES (1,'ordinary-fixture','Fixture','http://ordinary-fixture.invalid','fixture-token',1)",
    ).run();
    client.prepare(
      "INSERT OR REPLACE INTO settings (id,client_id,active_server_id) VALUES (1,'fixture',1)",
    ).run();
    client.prepare(
      "INSERT OR IGNORE INTO libraries (server_id,key,title,type,synced_at) VALUES (1,'movies','Movies','movie',1)",
    ).run();
    client.prepare(
      "INSERT INTO items (server_id,rating_key,library_key,title,type,tmdb_id,file_size,updated_at) VALUES (1,'one','movies','Fixture Movie','movie',123,1,1)",
    ).run();
  });
}

// These are coordinator/API fixtures with supplied collector evidence, NOT native
// Docker fresh-setup acceptance. The separate transport test exercises real sockets.
Deno.test('current QB paths trigger one bounded automatic refresh and preserve unrelated root revisions', async () => {
  prepareAutomaticSetup();
  const discovery = await import('../settings/hostDiscovery.ts');
  const { parseDockerReport } = await import('../settings/dockerStorage.ts');
  const { loadServiceRoots } = await import('../mediaDeletion/serviceStorage.ts');
  const restore = discovery.setHostDiscoveryReaderForTest(() =>
    Promise.resolve({
      report: parseDockerReport(dockerReport()),
      keyHash: 'fixture-key-hash',
    })
  );
  try {
    await discovery.enableHostDiscovery(1);
    await discovery.refreshHostDiscovery(1);
    const original = await loadServiceRoots(1);
    const testsBefore = arrConnectionTests;
    qbJobs = [{
      hash: 'a'.repeat(40),
      content_path: '/data/new-downloads/other',
      save_path: '/data/new-downloads',
      size: 100,
      total_size: 100,
    }];
    const preview = async () => {
      const response = await app.request('/api/libraries/movies/items/download-cleanup-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ratingKeys: ['one'] }),
      });
      assertEquals(response.status, 200);
      return (await response.json()).items[0];
    };
    const first = await preview();
    assertEquals(first.plexOnlyStatus, 'resolved', JSON.stringify(first));
    assertEquals(first.qbittorrentOnlyStatus, 'resolved', JSON.stringify(first));
    const updated = await loadServiceRoots(1);
    assert(updated.some((root) => root.serviceRoot === '/data/new-downloads'));
    for (const root of original) assertEquals(updated.find((entry) => entry.id === root.id), root);
    assertEquals(arrConnectionTests - testsBefore, 1);
    assertEquals((await preview()).plexOnlyStatus, 'resolved');
    assertEquals(arrConnectionTests - testsBefore, 1);
    qbJobs = [{ ...qbJobs[0], content_path: '/data/another/other', save_path: '/data/another' }];
    assertEquals((await preview()).plexOnlyStatus, 'error');
    assertEquals(arrConnectionTests - testsBefore, 1);
    withTransaction((c) =>
      c.prepare(
        "DELETE FROM host_discovery_roots WHERE root_id IN (SELECT id FROM service_path_roots WHERE service_key='qb:db:4')",
      ).run()
    );
    discovery.triggerHostDiscovery(1);
    await discovery.refreshHostDiscovery(1);
    const manualTests = arrConnectionTests;
    assertEquals(await discovery.refreshMissingDownloadRoot(1, 'qb:db:4'), false);
    assertEquals(arrConnectionTests, manualTests);
    assertEquals(await loadServiceRoots(1), updated);
    assertEquals(deleteCalls, 0);
  } finally {
    await discovery.refreshHostDiscovery(1);
    discovery.disableHostDiscovery(1);
    restore();
  }
});

Deno.test('host discovery fixture publishes from zero roots, preserves semantic revisions and refreshes changed mounts', async () => {
  prepareAutomaticSetup();
  const discovery = await import('../settings/hostDiscovery.ts');
  const { parseDockerReport } = await import('../settings/dockerStorage.ts');
  let report = parseDockerReport(dockerReport());
  let reads = 0;
  const restore = discovery.setHostDiscoveryReaderForTest(() => {
    reads++;
    return Promise.resolve({
      report: { ...report, generatedAt: new Date().toISOString() },
      keyHash: 'fixture-key-hash',
    });
  });
  try {
    const enabled = await app.request('/api/settings/service-storage/discovery/enable', {
      method: 'POST',
    });
    assertEquals(enabled.status, 200);
    await discovery.refreshHostDiscovery(1);
    const { loadServiceRoots } = await import('../mediaDeletion/serviceStorage.ts');
    const roots = await loadServiceRoots(1);
    assertEquals(roots.length, 3);
    assert(roots.every((r) => r.storageRoot.startsWith('/docker/')));
    await discovery.refreshHostDiscovery(1);
    assertEquals(await loadServiceRoots(1), roots);
    const before = reads;
    await Promise.all([discovery.refreshHostDiscovery(1), discovery.refreshHostDiscovery(1)]);
    assertEquals(reads - before, 1);
    report = structuredClone(report);
    report.containers[1].Mounts[0].Source = '/mnt/user/separate-copy';
    const changed = await loadServiceRoots(1);
    const arr = changed.find((r) => r.serviceKey === 'arr:3')!;
    assertEquals(arr.revision, 2);
    assert(arr.storageRoot.includes('separate-copy'));
    assertEquals(
      changed.find((r) => r.serviceKey === 'plex:movies'),
      roots.find((r) => r.serviceKey === 'plex:movies'),
    );
    const status = discovery.hostDiscoveryStatus(1);
    assert(
      status.services.every((s) => s.connected && s.state === 'ready'),
      JSON.stringify({
        status,
        timing: withTransaction((c) =>
          c.prepare('SELECT checked_at,scanned_at FROM host_discovery').all()
        ),
        now: Date.now(),
      }),
    );
    const test = await app.request('/api/integrations/arr/instances/3/test', { method: 'POST' });
    assertEquals(test.status, 200);
    await discovery.refreshHostDiscovery(1);
    assert(reads > before + 1);
    assertEquals(JSON.stringify(status).includes('fixture-key-hash'), false);
  } finally {
    await discovery.refreshHostDiscovery(1);
    discovery.disableHostDiscovery(1);
    restore();
  }
});

Deno.test('host discovery fixture keeps manual authority, holds unavailable evidence, and bounds failed retries', async () => {
  prepareAutomaticSetup();
  const discovery = await import('../settings/hostDiscovery.ts');
  const { parseDockerReport } = await import('../settings/dockerStorage.ts');
  const { loadServiceRoots } = await import('../mediaDeletion/serviceStorage.ts');
  let unavailable = false, reads = 0;
  const restore = discovery.setHostDiscoveryReaderForTest(() => {
    reads++;
    return unavailable
      ? Promise.reject(new Error('fixture failure'))
      : Promise.resolve({ report: parseDockerReport(dockerReport()), keyHash: 'fixture-key-hash' });
  });
  try {
    await discovery.enableHostDiscovery(1);
    await discovery.refreshHostDiscovery(1);
    const root = (await loadServiceRoots(1)).find((r) => r.serviceKey === 'arr:3')!;
    const manual = await app.request('/api/settings/service-storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...root, confirmed: true, storageRoot: '/explicit/manual' }),
    });
    assertEquals(manual.status, 201, await manual.text());
    await discovery.refreshHostDiscovery(1);
    assertEquals(
      (await loadServiceRoots(1)).find((r) => r.id === root.id)?.storageRoot,
      '/explicit/manual',
    );
    assert(
      discovery.hostDiscoveryStatus(1).services.find((s) => s.serviceKey === 'arr:3')?.reason
        ?.includes('Manual'),
    );
    unavailable = true;
    const invalid = await loadServiceRoots(1);
    assert(
      invalid.find((r) => r.serviceKey === 'plex:movies')?.configurationIdentity.startsWith(
        'discovery-unavailable:',
      ),
    );
    assertEquals(
      invalid.find((r) => r.id === root.id)?.configurationIdentity,
      root.configurationIdentity,
    );
    const before = reads;
    assertEquals(await discovery.refreshMissingDownloadRoot(1, 'qb:db:4'), false);
    await discovery.refreshHostDiscovery(1);
    await discovery.refreshHostDiscovery(1);
    assertEquals(reads, before);
    unavailable = false;
    discovery.triggerHostDiscovery(1);
    await discovery.refreshHostDiscovery(1);
    assert(
      !(await loadServiceRoots(1)).find((r) => r.serviceKey === 'plex:movies')
        ?.configurationIdentity.startsWith('discovery-unavailable:'),
    );
    discovery.disableHostDiscovery(1);
    assert(
      (await loadServiceRoots(1)).find((r) => r.serviceKey === 'plex:movies')?.configurationIdentity
        .startsWith('discovery-unavailable:'),
    );
  } finally {
    await discovery.refreshHostDiscovery(1);
    discovery.disableHostDiscovery(1);
    restore();
  }
});

Deno.test('host discovery fixture rejects late configuration results and atomic publication failures', async () => {
  for (const change of ['configuration', 'server', 'insert', 'pairing'] as const) {
    prepareAutomaticSetup();
    const discovery = await import('../settings/hostDiscovery.ts');
    const { parseDockerReport } = await import('../settings/dockerStorage.ts');
    const restore = discovery.setHostDiscoveryReaderForTest(() =>
      Promise.resolve({ report: parseDockerReport(dockerReport()), keyHash: 'fixture-key-hash' })
    );
    duringDiscovery = () =>
      withTransaction((c) => {
        if (change === 'configuration') {
          c.prepare('UPDATE qbittorrent_instances SET updated_at=99 WHERE id=4').run();
        }
        if (change === 'server') {
          c.prepare('UPDATE settings SET active_server_id=NULL WHERE id=1').run();
        }
        if (change === 'pairing') {
          const old = c.prepare(
            'SELECT daemon_id,key_hash,generation FROM host_discovery WHERE server_id=1',
          ).value<[string, string, number]>()!;
          c.prepare('DELETE FROM host_discovery WHERE server_id=1').run();
          c.prepare(
            'INSERT INTO host_discovery(server_id,pairing_id,daemon_id,key_hash,generation) VALUES (1,?,?,?,?)',
          ).run(crypto.randomUUID(), ...old);
        }
        if (change === 'insert') {
          c.exec(
            "CREATE TEMP TRIGGER reject_auto_root BEFORE INSERT ON service_path_roots WHEN NEW.service_key LIKE 'qb:%' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
          );
        }
      });
    try {
      await discovery.enableHostDiscovery(1);
      await discovery.refreshHostDiscovery(1);
      assertEquals(
        withTransaction((c) =>
          c.prepare('SELECT count(*) FROM service_path_roots').value<[number]>()![0]
        ),
        0,
      );
      assertEquals(deleteCalls, 0);
    } finally {
      if (change === 'insert') withTransaction((c) => c.exec('DROP TRIGGER reject_auto_root'));
      discovery.disableHostDiscovery(1);
      restore();
    }
  }
});

Deno.test('host discovery service backoff stops failed service scans while refreshing independent valid evidence', async () => {
  prepareAutomaticSetup();
  arrUnavailable = true;
  const discovery = await import('../settings/hostDiscovery.ts');
  const { parseDockerReport } = await import('../settings/dockerStorage.ts');
  const { loadServiceRoots } = await import('../mediaDeletion/serviceStorage.ts');
  const originalNow = Date.now;
  let clock = originalNow();
  let helperUnavailable = false;
  Date.now = () => clock;
  const restore = discovery.setHostDiscoveryReaderForTest(() =>
    helperUnavailable
      ? Promise.reject(new Error('transient helper failure'))
      : Promise.resolve({ report: parseDockerReport(dockerReport()), keyHash: 'fixture-key-hash' })
  );
  try {
    await discovery.enableHostDiscovery(1);
    await discovery.refreshHostDiscovery(1);
    assertEquals(arrConnectionTests, 1);
    for (const [delay, count] of [[4999, 1], [1, 2], [29999, 2], [1, 3], [59999, 3], [1, 4]]) {
      clock += delay;
      await discovery.refreshHostDiscovery(1);
      assertEquals(arrConnectionTests, count);
    }
    arrUnavailable = false;
    clock += 301_000;
    const roots = await loadServiceRoots(1);
    assertEquals(arrConnectionTests, 4);
    assert(roots.find((root) => root.serviceKey === 'plex:movies'));
    assert(roots.every((root) => !root.configurationIdentity.startsWith('discovery-unavailable:')));
    assertEquals(
      discovery.hostDiscoveryStatus(1).services.find((s) => s.serviceKey === 'arr:3')?.state,
      'needs_attention',
    );
    helperUnavailable = true;
    await discovery.refreshHostDiscovery(1);
    assert(
      (await loadServiceRoots(1)).some((r) =>
        r.configurationIdentity.startsWith('discovery-unavailable:')
      ),
    );
    helperUnavailable = false;
    clock += 4999;
    assert(
      (await loadServiceRoots(1)).some((r) =>
        r.configurationIdentity.startsWith('discovery-unavailable:')
      ),
    );
    clock += 1;
    assert(
      (await loadServiceRoots(1)).every((r) =>
        !r.configurationIdentity.startsWith('discovery-unavailable:')
      ),
    );
    clock += 301_000;
    await discovery.refreshHostDiscovery(1);
    assertEquals(arrConnectionTests, 4); // Host recovery must preserve the service's exhausted budget.
    assertEquals(await discovery.refreshMissingDownloadRoot(1, 'qb:db:4'), false);
    assertEquals(arrConnectionTests, 4);
    discovery.triggerHostDiscovery(1);
    await discovery.refreshHostDiscovery(1);
    assertEquals(arrConnectionTests, 5);
    assertEquals(
      discovery.hostDiscoveryStatus(1).services.find((s) => s.serviceKey === 'arr:3')?.state,
      'ready',
    );
  } finally {
    discovery.disableHostDiscovery(1);
    restore();
    Date.now = originalNow;
  }
});
async function enqueue(ratingKey = 'one') {
  const preview = await app.request('/api/libraries/movies/items/download-cleanup-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ratingKeys: [ratingKey] }),
  });
  assertEquals(preview.status, 200);
  const data = await preview.json();
  assert(data.items[0].plexOnlyFingerprint, JSON.stringify(data));
  const body = {
    clientRequestId: crypto.randomUUID(),
    ratingKeys: [ratingKey],
    coordinatedRatingKeys: [],
    cleanupDownloadRatingKeys: [],
    cleanupPreviewFingerprints: { [ratingKey]: data.items[0].plexOnlyFingerprint },
  };
  const accepted = await app.request('/api/libraries/movies/items', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await accepted.json();
  assertEquals(accepted.status, 202, JSON.stringify(result));
  const repeated = await app.request('/api/libraries/movies/items', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assertEquals((await repeated.json()).operationId, result.operationId);
  return result.operationId as string;
}
Deno.test('ordinary Plex service success and async acceptance complete without physical or catalog absence', async () => {
  for (const status of [200, 202, 204]) {
    reset();
    responseStatus = status;
    const id = await enqueue();
    await runDeletionWorkerOnceForTest();
    const operation = getDeletionOperation(id, 1) as unknown as DeletionOperation;
    assertEquals(operation.status, 'completed', JSON.stringify(operation));
    assertEquals(deleteCalls, 1);
    assertEquals(
      operation.targets[0].serviceOutcomes?.[0].status,
      status === 202 ? 'accepted' : 'succeeded',
    );
    assertEquals(operation.targets[0].storageOutcome, 'unknown');
    assertEquals(
      await Deno.readTextFile(file),
      'Fixture content retained by the service recycle-bin simulation',
    );
  }
});
Deno.test('simple Plex flow needs no root discovery, saved relationships or reachable unchecked Arr', async () => {
  prepareAutomaticSetup();
  discoverableRoots = false;
  arrUnavailable = true;
  withTransaction((client) => client.prepare('DELETE FROM qbittorrent_instances').run());
  const id = await enqueue();
  await runDeletionWorkerOnceForTest();
  const operation = getDeletionOperation(id, 1) as unknown as DeletionOperation;
  assertEquals(operation.status, 'completed', JSON.stringify(operation));
  assertEquals(deleteCalls, 1);
  assertEquals(operation.targets[0].serviceOutcomes?.length, 1);
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT count(*) AS count FROM service_path_roots').get()
    ),
    { count: 0 },
  );
});

Deno.test('ordinary complete empty QB stays eligible through preview enqueue and worker without storage setup', async () => {
  prepareAutomaticSetup();
  arrUnavailable = true;
  const id = await enqueue();
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM service_path_roots').value<[number]>()?.[0]
    ),
    0,
  );
  await runDeletionWorkerOnceForTest();
  const operation = getDeletionOperation(id, 1) as unknown as DeletionOperation;
  assertEquals(operation.status, 'completed', JSON.stringify(operation));
  assertEquals(operation.targets[0].serviceOwnedDeletion, true);
  assertEquals(operation.targets[0].serviceOutcomes?.length, 1);
  assertEquals(deleteCalls, 1);
  assertEquals(
    await Deno.readTextFile(file),
    'Fixture content retained by the service recycle-bin simulation',
  );
});

Deno.test('simple Plex flow stops before mutation if playback, selected files or retained ownership changes after confirmation', async () => {
  for (const change of ['playback', 'selected_file', 'retained_file'] as const) {
    reset();
    const id = await enqueue();
    if (change === 'playback') playing = true;
    if (change === 'selected_file') {
      raw.Media[0].Part[0].file = '/service-only/Fixture/new-version.mkv';
    }
    if (change === 'retained_file') retainedSameFile = true;
    await runDeletionWorkerOnceForTest();
    const operation = getDeletionOperation(id, 1) as unknown as DeletionOperation;
    assert(operation.status !== 'completed', `${change}: ${JSON.stringify(operation)}`);
    assertEquals(deleteCalls, 0, change);
  }
});

Deno.test('service error and lost response preserve attempt evidence and cannot replay as success', async () => {
  for (const uncertain of [false, true]) {
    reset();
    responseStatus = 403;
    lost = uncertain;
    const id = await enqueue();
    await runDeletionWorkerOnceForTest();
    let operation = getDeletionOperation(id, 1) as unknown as DeletionOperation;
    assert(operation.status !== 'completed', JSON.stringify(operation));
    assertEquals(deleteCalls, 1);
    assertEquals(
      operation.targets[0].serviceOutcomes?.[0].status,
      uncertain ? 'uncertain' : 'failed',
    );
    assertEquals(operation.targets[0].serviceOutcomes?.[0].httpStatus, uncertain ? undefined : 403);
    responseStatus = 200;
    lost = false;
    retryDeletionOperation(id, 1);
    await runDeletionWorkerOnceForTest();
    operation = getDeletionOperation(id, 1) as unknown as DeletionOperation;
    assert(operation.status !== 'completed');
    assertEquals(deleteCalls, 1);
    assertEquals(
      operation.targets[0].serviceOutcomes?.[0].status,
      uncertain ? 'uncertain' : 'failed',
    );
    assertEquals(operation.targets[0].serviceOutcomes?.[0].httpStatus, uncertain ? undefined : 403);
  }
});

function prepareAutomaticSetup() {
  reset();
  automaticSetup = true;
  discoverableRoots = true;
  raw.Media[0].Part[0].file = '/data/Movies/Fixture/movie.mkv';
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO qbittorrent_instances (id,server_id,name,url,username,password,created_at,updated_at) VALUES (4,1,'QB fixture','http://qb-setup-fixture.invalid','fixture-user','fixture-password',1,1)",
    ).run();
    client.prepare(
      "INSERT INTO arr_instances (id,server_id,type,name,url,api_key,created_at,updated_at) VALUES (3,1,'radarr','Arr fixture','http://arr-setup-fixture.invalid','fixture-api-key',1,1)",
    ).run();
    client.prepare(
      "INSERT INTO arr_library_mappings (server_id,library_key,arr_instance_id) VALUES (1,'movies',3)",
    ).run();
  });
}
async function storageSetup() {
  const response = await app.request('/api/settings/service-storage?discover=true');
  assertEquals(response.status, 200);
  return await response.json();
}
function confirmLayout(fingerprint: string, confirmed = true) {
  return app.request('/api/settings/service-storage/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint, confirmed }),
  });
}

function dockerReport() {
  return JSON.stringify({
    version: 3,
    daemonId: 'fixture-daemon',
    generatedAt: new Date().toISOString(),
    hostAddresses: [],
    containers: [
      'ordinary-fixture.invalid',
      'arr-setup-fixture.invalid',
      'qb-setup-fixture.invalid',
    ]
      .map((name) => ({
        Id: name,
        Name: `/${name}`,
        State: { Running: true },
        NetworkMode: 'bridge',
        Networks: [{ Name: 'fixture', IPAddress: '', GlobalIPv6Address: '', Aliases: [name] }],
        Ports: [{ containerPort: 80, hostPort: 80, hostIp: '0.0.0.0' }],
        Mounts: [{ Type: 'bind', Source: '/mnt/user/media', Destination: '/data' }],
        volumeSubpaths: [],
        tmpfsTargets: [],
        nonRecursiveBindTargets: [],
      })),
  });
}
function dockerRequest(action: string, body: object) {
  return app.request(`/api/settings/service-storage/docker-${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

Deno.test('Docker report imports concrete mappings and enables the existing durable service workflow', async () => {
  prepareAutomaticSetup();
  const download = await app.request('/api/settings/service-storage/docker-report.sh');
  assertEquals(download.status, 200);
  assert(download.headers.get('content-disposition')?.includes('librarian-docker-report.sh'));
  const script = await download.text();
  assert(script.startsWith('#!/bin/sh\n'));
  assertEquals(script.includes('\r'), false);
  const report = dockerReport();
  const previewResponse = await dockerRequest('preview', { report });
  assertEquals(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assertEquals(preview.status, 'confirmation_required');
  assertEquals(
    preview.services.every((s: { matchedBy: string }) => s.matchedBy === 'address'),
    true,
  );
  assertEquals((await storageSetup()).relationships.length, 0);
  const saved = await dockerRequest('confirm', {
    report,
    fingerprint: preview.fingerprint,
    confirmed: true,
  });
  assertEquals(saved.status, 201);
  const setup = await saved.json();
  assertEquals(setup.relationships.length, 3);
  assertEquals(
    setup.relationships.every((r: { storageRoot: string }) => r.storageRoot.startsWith('/docker/')),
    true,
  );
  assertEquals(JSON.stringify(setup).includes('fixture-password'), false);
  const operation = await enqueue();
  await runDeletionWorkerOnceForTest();
  assertEquals(getDeletionOperation(operation, 1)?.status, 'completed');
  assertEquals(deleteCalls, 1);
});

Deno.test('Docker confirmation rejects changed discovery and rolls back partial writes', async () => {
  for (const failure of ['discovery', 'during_discovery', 'insert'] as const) {
    prepareAutomaticSetup();
    const report = dockerReport();
    const preview = await (await dockerRequest('preview', { report })).json();
    if (failure === 'discovery') qbRoot = '/elsewhere';
    if (failure === 'during_discovery') {
      duringDiscovery = () =>
        withTransaction((client) =>
          client.prepare('UPDATE qbittorrent_instances SET updated_at=99 WHERE id=4').run()
        );
    }
    if (failure === 'insert') {
      withTransaction((client) =>
        client.exec(
          "CREATE TEMP TRIGGER reject_docker_root BEFORE INSERT ON service_path_roots WHEN NEW.service_key LIKE 'qb:%' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
        )
      );
    }
    try {
      assertEquals(
        (await dockerRequest('confirm', {
          report,
          fingerprint: preview.fingerprint,
          confirmed: true,
        })).status,
        409,
      );
      assertEquals((await storageSetup()).relationships.length, 0);
    } finally {
      if (failure === 'insert') {
        withTransaction((client) => client.exec('DROP TRIGGER reject_docker_root'));
      }
    }
  }
});

Deno.test('Docker replacement requires consent and invalidates queued deletion without erasing evidence', async () => {
  prepareAutomaticSetup();
  const initial = await storageSetup();
  assertEquals((await confirmLayout(initial.automation.proposal.fingerprint)).status, 201);
  const operation = await enqueue();
  const report = dockerReport();
  const preview = await (await dockerRequest('preview', { report })).json();
  assertEquals(preview.replacementRequired, true);
  const body = { report, fingerprint: preview.fingerprint, confirmed: true };
  assertEquals((await dockerRequest('confirm', body)).status, 409);
  assertEquals((await dockerRequest('confirm', { ...body, replaceExisting: true })).status, 201);
  await runDeletionWorkerOnceForTest();
  assertEquals(deleteCalls, 0);
  assertEquals(getDeletionOperation(operation, 1)?.status, 'needs_attention');
  assertEquals(
    await Deno.readTextFile(file),
    'Fixture content retained by the service recycle-bin simulation',
  );
});

Deno.test('Docker partial import retires unavailable Arr authority and protects retained folder content after recovery', async () => {
  prepareAutomaticSetup();
  const initial = await storageSetup();
  await confirmLayout(initial.automation.proposal.fingerprint);
  const operation = await enqueue();
  const evidence = getDeletionOperation(operation, 1);
  arrUnavailable = true;
  const report = dockerReport();
  const preview = await (await dockerRequest('preview', { report })).json();
  assertEquals(
    preview.invalidatedServices.map((service: { serviceKey: string }) => service.serviceKey),
    ['arr:3'],
  );
  assertEquals(preview.replacementRequired, true);
  assertEquals(
    (await dockerRequest('confirm', {
      report,
      fingerprint: preview.fingerprint,
      confirmed: true,
      replaceExisting: true,
    })).status,
    201,
  );
  assertEquals(getDeletionOperation(operation, 1), evidence);
  assertEquals(
    (await storageSetup()).relationships.some((root: { serviceKey: string }) =>
      root.serviceKey === 'arr:3'
    ),
    false,
  );
  arrUnavailable = false;
  arrCurrentMedia = true;
  retainedInArrFolder = true;
  const inspect = async () =>
    await (await app.request('/api/libraries/movies/items/download-cleanup-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ratingKeys: ['one'] }),
    })).json();
  const missing = await inspect();
  assertEquals(missing.items[0].sonarrCleanupStatus, 'error');
  assert(
    String(missing.items[0].sonarrCleanupReason).toLowerCase().includes('storage relationship'),
    JSON.stringify(missing),
  );
  const recovered = await (await dockerRequest('preview', { report })).json();
  assertEquals(
    (await dockerRequest('confirm', {
      report,
      fingerprint: recovered.fingerprint,
      confirmed: true,
      replaceExisting: true,
    })).status,
    201,
  );
  const guarded = await inspect();
  assertEquals(guarded.items[0].sonarrCleanupStatus, 'error');
  assert(
    String(guarded.items[0].sonarrCleanupReason).includes('retained in Plex'),
    JSON.stringify(guarded),
  );
  assertEquals(guarded.items[0].sonarrCleanupFingerprint, undefined);
  assertEquals(deleteCalls, 0);
});

Deno.test('fresh setup uses one group confirmation, enables durable Plex deletion and reuses roots for a second title', async () => {
  prepareAutomaticSetup();
  const before = await storageSetup();
  assertEquals(before.relationships, []);
  assertEquals(before.automation.status, 'confirmation_required');
  const preview = await (await app.request('/api/libraries/movies/items/download-cleanup-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ratingKeys: ['one'] }),
  })).json();
  assertEquals(preview.items[0].plexOnlyStatus, 'resolved');
  assert(typeof preview.items[0].plexOnlyFingerprint === 'string');
  assertEquals((await confirmLayout(before.automation.proposal.fingerprint, false)).status, 400);
  const confirmed = await confirmLayout(before.automation.proposal.fingerprint);
  assert(confirmed.ok, await confirmed.text());
  const after = await storageSetup();
  assertEquals(after.automation.status, 'ready');
  assertEquals(after.relationships.length, 3);
  assertEquals(JSON.stringify(after).includes('fixture-password'), false);
  const operation = await enqueue();
  await runDeletionWorkerOnceForTest();
  assertEquals(getDeletionOperation(operation, 1)?.status, 'completed');
  assertEquals(deleteCalls, 1); // QB fixture rejects every mutation.
  raw.ratingKey = 'two';
  raw.title = 'Second Fixture Movie';
  raw.Media[0].Part[0].file = '/data/Movies/Second/movie.mkv';
  withTransaction((client) =>
    client.prepare(
      "INSERT INTO items (server_id,rating_key,library_key,title,type,tmdb_id,file_size,updated_at) VALUES (1,'two','movies','Second Fixture Movie','movie',123,1,1)",
    ).run()
  );
  const reused = await storageSetup();
  assertEquals(reused.automation.status, 'ready');
  assertEquals(reused.relationships, after.relationships);
  const secondOperation = await enqueue('two');
  await runDeletionWorkerOnceForTest();
  assertEquals(getDeletionOperation(secondOperation, 1)?.status, 'completed');
  assertEquals(deleteCalls, 2);
  assertEquals(
    await Deno.readTextFile(file),
    'Fixture content retained by the service recycle-bin simulation',
  );
});

Deno.test('group confirmation rejects stale discovered roots and connection identity without saving anything', async () => {
  for (const change of ['discovery', 'identity', 'during_discovery'] as const) {
    prepareAutomaticSetup();
    const before = await storageSetup();
    if (change === 'discovery') qbRoot = '/other-volume/downloads';
    else if (change === 'during_discovery') {
      duringDiscovery = () =>
        withTransaction((client) =>
          client.prepare('UPDATE qbittorrent_instances SET updated_at=2 WHERE id=4').run()
        );
    } else {withTransaction((client) =>
        client.prepare('UPDATE qbittorrent_instances SET updated_at=2 WHERE id=4').run()
      );}
    assertEquals((await confirmLayout(before.automation.proposal.fingerprint)).status, 409);
    assertEquals((await storageSetup()).relationships, []);
    assertEquals(deleteCalls, 0);
  }
});

Deno.test('unavailable optional Arr does not prevent grouped Plex/QB setup or independently eligible deletion', async () => {
  prepareAutomaticSetup();
  arrUnavailable = true;
  const before = await storageSetup();
  assertEquals(before.automation.status, 'confirmation_required');
  assertEquals(
    before.automation.proposal.relationships.map((root: { serviceKey: string }) => root.serviceKey),
    ['plex:movies', 'qb:db:4'],
  );
  assertEquals(
    before.automation.unavailableServices.map((service: { serviceKey: string }) =>
      service.serviceKey
    ),
    ['arr:3'],
  );
  const response = await confirmLayout(before.automation.proposal.fingerprint);
  assertEquals(response.status, 201);
  const saved = await response.json();
  assertEquals(saved.automation.status, 'ready');
  assertEquals(
    saved.relationships.some((root: { serviceKey: string }) => root.serviceKey === 'arr:3'),
    false,
  );
  const preview = await (await app.request('/api/libraries/movies/items/download-cleanup-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ratingKeys: ['one'] }),
  })).json();
  assertEquals(preview.items[0].plexOnlyStatus, 'resolved');
  assertEquals(preview.items[0].sonarrCleanupStatus, 'error');
  assertEquals(preview.items[0].sonarrCleanupFingerprint, undefined);
  const operation = await enqueue();
  await runDeletionWorkerOnceForTest();
  assertEquals(getDeletionOperation(operation, 1)?.status, 'completed');
  assertEquals(deleteCalls, 1);
});

Deno.test('group confirmation rolls back the whole batch if any relationship cannot be saved', async () => {
  prepareAutomaticSetup();
  const before = await storageSetup();
  withTransaction((client) =>
    client.exec(
      "CREATE TRIGGER reject_fixture_qb_root BEFORE INSERT ON service_path_roots WHEN NEW.service_key='qb:db:4' BEGIN SELECT RAISE(ABORT,'fixture save failure'); END;",
    )
  );
  try {
    assertEquals((await confirmLayout(before.automation.proposal.fingerprint)).status, 409);
    assertEquals((await storageSetup()).relationships, []);
    assertEquals(deleteCalls, 0);
  } finally {
    withTransaction((client) => client.exec('DROP TRIGGER reject_fixture_qb_root'));
  }
});

Deno.test('setup discovers Plex roots without silently creating storage relationships', async () => {
  reset();
  discoverableRoots = true;
  const response = await app.request('/api/settings/service-storage?discover=true');
  assertEquals(response.status, 200);
  const settings = await response.json();
  assertEquals(settings.endpoints[0].roots, ['/service-only']);
  assertEquals(settings.endpoints[0].discoveryError, undefined);
  assert(settings.endpoints[0].connectionTestedAt);
  assertEquals(settings.relationships, []);
  assertEquals(deleteCalls, 0);
  assertEquals(JSON.stringify(settings).includes('fixture-token'), false);
});

Deno.test('manual roots support empty discovery, reject overlap and stale writes, and invalidate queued consent', async () => {
  reset();
  const settings = await (await app.request('/api/settings/service-storage?discover=true')).json();
  assertEquals(settings.endpoints.length, 1);
  assert(settings.endpoints[0].connectionTestedAt); // A real identity request succeeded, although root discovery is unavailable.
  assert(settings.endpoints[0].discoveryError);
  assertEquals(JSON.stringify(settings).includes('fixture-token'), false);
  const body = {
    serviceKey: 'plex:movies',
    configurationIdentity: settings.endpoints[0].configurationIdentity,
    serviceRoot: '/service-only',
    storageRoot: '/storage',
    caseSensitive: true,
    hasAliases: false,
    confirmed: true,
  };
  const save = (value: unknown) =>
    app.request('/api/settings/service-storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  assertEquals((await save({ ...body, confirmed: false })).status, 400);
  const saved = await save(body);
  assertEquals(saved.status, 201);
  const { id: rootId } = await saved.json();
  assertEquals(
    (await save({ ...body, serviceRoot: '/service-only/nested', storageRoot: '/different' }))
      .status,
    409,
  );
  assertEquals(
    (await save({ ...body, serviceRoot: '/elsewhere', storageRoot: '/storage' })).status,
    409,
  );
  assertEquals(
    (await save({ ...body, configurationIdentity: 'old', serviceRoot: '/different' })).status,
    409,
  );
  const id = await enqueue();
  assertEquals(
    (await save({ ...body, id: rootId, revision: 1, storageRoot: '/changed' })).status,
    201,
  );
  assertEquals((await save({ ...body, id: rootId, revision: 1 })).status, 409);
  await runDeletionWorkerOnceForTest();
  assertEquals(deleteCalls, 0);
  assert(getDeletionOperation(id, 1)?.status !== 'completed');
  const { cancelDeletionOperation } = await import('./service.ts');
  cancelDeletionOperation(id, 1);
  assertEquals(getDeletionOperation(id, 1)?.status, 'cancelled');
});

Deno.test('restart resumes a recorded successful service response without repeating its deletion', async () => {
  reset();
  const id = await enqueue();
  withTransaction((client) => {
    const [targetId, rawSnapshot] = client.prepare(
      'SELECT id,snapshot FROM deletion_targets WHERE operation_id=?',
    ).value<[number, string]>(id)!;
    const snapshot = JSON.parse(rawSnapshot);
    snapshot.ordinaryAttempts = {
      'plex:one': {
        service: 'Plex',
        action: 'Delete selected media',
        startedAt: 1,
        response: { status: 'succeeded', httpStatus: 200 },
      },
    };
    client.prepare("UPDATE deletion_targets SET snapshot=?,status='running' WHERE id=?").run(
      JSON.stringify(snapshot),
      targetId,
    );
    client.prepare("UPDATE deletion_operations SET status='running' WHERE id=?").run(id);
  });
  const { recoverInterruptedDeletionWork } = await import('./core/recovery.ts');
  withTransaction((client) => recoverInterruptedDeletionWork(client, 2));
  await runDeletionWorkerOnceForTest();
  assertEquals(getDeletionOperation(id, 1)?.status, 'completed');
  assertEquals(deleteCalls, 0);
});

Deno.test('host discovery rechecks DNS before cached freshness and restores authority only after a valid answer', async () => {
  prepareAutomaticSetup();
  const discovery = await import('../settings/hostDiscovery.ts');
  const { parseDockerReport } = await import('../settings/dockerStorage.ts');
  const { loadServiceRoots } = await import('../mediaDeletion/serviceStorage.ts');
  const report = parseDockerReport(dockerReport());
  report.containers[0].Networks[0].Aliases = [];
  report.containers[0].Networks[0].IPAddress = '172.20.0.2';
  const restore = discovery.setHostDiscoveryReaderForTest(() =>
    Promise.resolve({
      report: { ...report, generatedAt: new Date().toISOString() },
      keyHash: 'fixture-key-hash',
    })
  );
  const originalDns = Deno.resolveDns;
  let address = '172.20.0.2';
  let calls = 0;
  Deno.resolveDns = ((_host: string, type: string) => {
    calls++;
    return Promise.resolve(type === 'A' ? [address] : []);
  }) as typeof Deno.resolveDns;
  try {
    await discovery.enableHostDiscovery(1);
    await discovery.refreshHostDiscovery(1);
    const original = await loadServiceRoots(1);
    assertEquals(original.length, 3);
    const plex = original.find((r) => r.serviceKey === 'plex:movies')!;
    assert(!plex.configurationIdentity.startsWith('discovery-unavailable:'));
    const before = calls;
    assertEquals(await loadServiceRoots(1), original);
    assert(calls > before);
    address = '203.0.113.1';
    const invalid = await loadServiceRoots(1);
    assert(
      invalid.find((r) => r.id === plex.id)!.configurationIdentity.startsWith(
        'discovery-unavailable:',
      ),
    );
    assertEquals(
      invalid.find((r) => r.serviceKey === 'arr:3'),
      original.find((r) => r.serviceKey === 'arr:3'),
    );
    address = '172.20.0.2';
    assertEquals(await loadServiceRoots(1), original);
  } finally {
    discovery.disableHostDiscovery(1);
    restore();
    Deno.resolveDns = originalDns;
  }
});
