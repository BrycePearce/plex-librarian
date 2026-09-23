import { assertEquals } from '@std/assert';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { ServiceOwnedPlan } from './serviceOwnedPlanning.ts';
import { parseHistoricalImports } from '../../integrations/arr/historicalImports.ts';
import type { RadarrMovieSnapshot } from '../../integrations/arr/client.ts';
import { planServiceOwnedRetention } from './serviceOwnedRetention.ts';

Deno.env.set('DB_PATH', ':memory:');
const { withTransaction } = await import('../../db/index.ts');
const { discoverHistoricalDownloads } = await import('./serviceOwnedDiscovery.ts');
withTransaction((db) =>
  db.exec(
    'CREATE TABLE servers(id INTEGER PRIMARY KEY); CREATE TABLE arr_instances(id INTEGER PRIMARY KEY); INSERT INTO servers VALUES(1); INSERT INTO arr_instances VALUES(1);',
  )
);
const migration = await Deno.readTextFile(
  new URL('../../../drizzle/0059_tiny_star_brand.sql', import.meta.url),
);
withTransaction((db) => db.exec(migration.split('--> statement-breakpoint')[0]));
withTransaction((db) =>
  db.prepare(
    'INSERT INTO historical_download_access(id,server_id,arr_instance_id,configuration,revision,status) VALUES(?,?,?,?,?,?)',
  ).run(
    'access',
    1,
    1,
    JSON.stringify({
      enabled: true,
      remoteRoot: '/radarr-complete',
      localRoot: '/mounted',
      noRemainingClient: true,
    }),
    'one',
    'available',
  )
);
const raw = [{
  id: 11,
  movieId: 7,
  eventType: 'downloadFolderImported',
  date: '2021-09-01',
  downloadId: null,
  data: {
    fileId: '42',
    droppedPath: '/radarr-complete/Film.mkv',
    importedPath: '/movies/Film.mkv',
  },
}];
const snapshot: RadarrMovieSnapshot = {
  movieId: 7,
  movieFileId: 42,
  files: [{ id: 42, movieId: 7, path: '/movies/Film.mkv', size: 7, relativePath: 'Film.mkv' }],
};
function fixture() {
  let historyReads = 0;
  let fileReads = 0;
  let unavailable = false;
  const action = {
    id: 'arr:1:file:42',
    service: 'radarr',
    instanceId: 1,
    serviceKey: 'arr:1',
    recordId: 7,
    fileId: 42,
    targetId: '42',
    selected: true,
    presence: 'current',
    effectsComplete: true,
    entries: [{ id: 'arr:1:/movies/Film.mkv', path: '/movies/Film.mkv' }],
    files: [{ path: '/movies/Film.mkv', size: 7 }],
  } as ServiceOwnedPlan['actions'][number];
  const plan = {
    selection: { type: 'movie', ratingKey: 'film', mediaId: 42 },
    arrSelected: true,
    actions: [action],
    retention: planServiceOwnedRetention({
      actions: [action],
      retainedEntries: [],
      evidenceRevision: 'one',
      qbInventory: 'unconfigured',
    }),
  } as ServiceOwnedPlan;
  const target = {
    instanceId: 1,
    instanceType: 'radarr',
    client: {
      radarrMovieSnapshot: (_id: number, known: unknown) => {
        fileReads++;
        assertEquals(known, snapshot.files[0]);
        if (unavailable) throw new Error('No native movie pointer');
        return Promise.resolve(snapshot);
      },
      historicalImports: (_id: number, observed: unknown) => {
        historyReads++;
        assertEquals(observed, raw);
        return Promise.resolve(parseHistoricalImports(observed, 7, 'radarr'));
      },
    },
  } as unknown as ArrDeleteTarget;
  return {
    plan,
    action,
    reads: () => [historyReads, fileReads],
    fail: () => unavailable = true,
    discover: (plans = [plan]) =>
      discoverHistoricalDownloads(
        1,
        plans,
        [target],
        new Map(),
        new Map([['1:7', Promise.resolve(raw)]]),
        new Map([['1:7', Promise.resolve(snapshot.files[0])]]),
      ),
  };
}

Deno.test('Radarr shared discovery keeps discriminated exact scope and reuses title reads', async () => {
  const f = fixture();
  const result = await f.discover([f.plan, f.plan]);
  assertEquals(f.reads(), [1, 1]);
  assertEquals(result.scope.length, 1);
  assertEquals(result.scope[0].service, 'radarr');
  assertEquals(result.scope[0].movieId, 7);
  assertEquals(result.scope[0].seriesId, undefined);
  assertEquals(result.scope[0].path, '/mounted/Film.mkv');
  assertEquals(result.preview.candidates[0].actionIds, ['arr:1:file:42']);
  assertEquals(
    result.preview.candidates[0].size,
    0,
    'discovery does not claim a filesystem observation',
  );
});

Deno.test('Radarr held/unchecked actions and unavailable optional lineage do not alter ordinary plan', async () => {
  for (const state of ['kept', 'held'] as const) {
    const f = fixture();
    f.plan.retention.decisions[0].state = state;
    assertEquals((await f.discover()).scope, []);
  }
  const f = fixture();
  f.plan.retention.decisions[0].requested = false;
  assertEquals((await f.discover()).scope, []);
  const g = fixture();
  const before = structuredClone(g.plan);
  g.fail();
  assertEquals((await g.discover()).scope, []);
  assertEquals(g.plan, before);
});
