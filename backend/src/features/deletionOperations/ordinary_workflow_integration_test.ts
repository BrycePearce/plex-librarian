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
let qbRoot = '/data/.torrents/complete';
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
    if (init?.method && init.method !== 'GET') throw new Error('Unexpected Arr mutation');
    if (arrUnavailable) {
      return Promise.resolve(new Response('Fixture connection unavailable', { status: 401 }));
    }
    const body = url.pathname === '/api/v3/system/status'
      ? { version: '5.0', appName: 'Radarr' }
      : url.pathname === '/api/v3/rootfolder'
      ? [{ id: 1, path: '/data/Movies' }]
      : ['/api/v3/remotepathmapping', '/api/v3/movie'].includes(url.pathname)
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
      ? Response.json([])
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
    ? { MediaContainer: { Metadata: [] } }
    : path === '/library/sections/movies/all'
    ? { MediaContainer: { Metadata: [raw], totalSize: 1 } }
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
  qbRoot = '/data/.torrents/complete';
  duringDiscovery = undefined;
  raw.ratingKey = 'one';
  raw.title = 'Fixture Movie';
  raw.Media[0].Part[0].file = '/service-only/Fixture/movie.mkv';
  withTransaction((client) => {
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
  assertEquals(preview.items[0].plexOnlyStatus, 'error');
  assertEquals(preview.items[0].plexOnlyFingerprint, undefined);
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
