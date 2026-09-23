import { assertEquals, assertRejects } from '@std/assert';
import {
  historicalQbTranslations,
  type HistoricalQbWitnessCache,
} from './historicalQbTranslation.ts';
import type { HistoricalAccessStatus } from '../../../../shared/historicalDownloads.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { AcceptedHistoricalDownload } from './historicalDownloadPlanning.ts';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import type { HistoricalImport } from '../../integrations/arr/historicalImports.ts';

function fixture() {
  let endpointReads = 0;
  let mappingReads = 0;
  let manifestReads = 0;
  let historyReads = 0;
  let recentReads = 0;
  const recentIds: string[] = [];
  const history = new Map<string, HistoricalImport[]>();
  const endpoints = ['http://qb.fixture:8080'];
  const hints: Array<{ host: string; remotePath: string; localPath: string }> = [];
  const access = [{
    id: 'access',
    instanceId: 1,
    revision: 'one',
    status: 'available',
    configuration: {
      enabled: true,
      remoteRoot: '/completed',
      localRoot: '/fixture-local',
      noRemainingClient: false,
    },
  }] as HistoricalAccessStatus[];
  const candidates = Array.from({ length: 23 }, (_, i) => ({
    id: String(i),
    instanceId: 1,
    accessId: 'access',
    accessRevision: 'one',
    lineage: {
      source: `/completed/Manhattan/${i}.mkv`,
      imports: [{
        downloadId: 'season-hash',
        droppedPath: `/completed/Manhattan/${i}.mkv`,
      }],
    },
    filesystem: { entry: `/fixture-local/Manhattan/${i}.mkv` },
  })) as AcceptedHistoricalDownload[];
  const jobs = [{
    id: 'season-hash',
    savePath: '/completed',
    contentPath: '/completed/Manhattan',
    size: 161,
    fileCount: 23,
    filesTruncated: false,
    manifestFiles: candidates.map((_, i) => ({ path: `Manhattan/${i}.mkv`, size: 7 })),
  }] as DownloadJob[];
  const target: DownloadClientTarget = {
    provider: 'qbittorrent',
    instanceKey: 'qb:1',
    instanceId: 1,
    instanceName: 'Fixture QB',
    instanceUrl: endpoints[0],
    configurationIdentity: 'one',
    client: {
      findJob: (id) => {
        manifestReads++;
        return Promise.resolve(jobs.find((j) => j.id === id) ?? null);
      },
      listJobSummaries: () => Promise.resolve(jobs),
      deleteJob: () => {
        throw new Error('Never delete a job');
      },
    },
  };
  const arr = [{
    instanceId: 1,
    instanceType: 'sonarr',
    client: {
      recentImportedDownloadIds: () => {
        recentReads++;
        return Promise.resolve(recentIds);
      },
      historicalImportsForDownload: (hash: string) => {
        historyReads++;
        return Promise.resolve(history.get(hash) ?? []);
      },
      qbittorrentEndpoints: () => {
        endpointReads++;
        return Promise.resolve(endpoints);
      },
      remotePathHints: () => {
        mappingReads++;
        return Promise.resolve(hints);
      },
    },
  }] as unknown as ArrDeleteTarget[];
  const resolve = () => historicalQbTranslations(target, arr, access, candidates, jobs, new Map());
  return {
    target,
    arr,
    access,
    candidates,
    jobs,
    endpoints,
    hints,
    history,
    recentIds,
    recentReads: () => recentReads,
    historyReads: () => historyReads,
    resolve,
    counts: () => ({ endpointReads, mappingReads, manifestReads }),
  };
}

Deno.test('automatic QB translation uses endpoint, matching download ID, exact manifest/import and verified access', async () => {
  const f = fixture();
  assertEquals(await f.resolve(), [{ remote: '/completed', local: '/fixture-local' }]);
  assertEquals(f.counts(), { endpointReads: 1, mappingReads: 1, manifestReads: 1 });
  assertEquals(f.target.pathMappings, undefined);
});

function unrelatedLiveImport(f: ReturnType<typeof fixture>) {
  const hash = 'ab'.repeat(20);
  f.jobs[0] = {
    ...f.jobs[0],
    id: hash,
    contentPath: '/completed/Other Show',
    fileCount: 1,
    manifestFiles: [{ path: 'Other Show/episode.mkv', size: 7 }],
  };
  f.history.set(hash, [{
    historyId: 10,
    seriesId: 99,
    episodeId: 100,
    fileId: 101,
    downloadId: hash.toUpperCase(),
    droppedPath: '/completed/Other Show/episode.mkv',
    importedPath: '/library/Other Show/episode.mkv',
    date: '2026-01-01T00:00:00Z',
  }]);
  return hash;
}

Deno.test('absent selected jobs use another live import without any remote mapping', async () => {
  const f = fixture();
  unrelatedLiveImport(f);
  assertEquals(await f.resolve(), [{ remote: '/completed', local: '/fixture-local' }]);
  assertEquals(f.historyReads(), 1);
  assertEquals(f.counts().manifestReads, 1);
  assertEquals(f.hints, []);
  f.history.clear();
  assertEquals(await f.resolve(), [], 'Fresh checks must not reuse old witness evidence');
});

Deno.test('unrelated live import requires exact hash/path agreement and matching endpoint', async () => {
  for (const change of ['hash', 'path', 'endpoint', 'conflict']) {
    const f = fixture();
    const hash = unrelatedLiveImport(f);
    const records = f.history.get(hash)!;
    if (change === 'hash') records[0].downloadId = 'cd'.repeat(20);
    if (change === 'path') records[0].droppedPath = '/completed/Other Show/wrong.mkv';
    if (change === 'endpoint') f.endpoints[0] = 'http://different.fixture:8080';
    if (change === 'conflict') {
      records.push({ ...records[0], droppedPath: '/completed/Other Show/conflict.mkv' });
    }
    assertEquals(await f.resolve(), [], change);
  }
});

Deno.test('recent import hints prioritize a live TV witness after more than twenty movie jobs', async () => {
  const f = fixture();
  const hash = unrelatedLiveImport(f);
  const tv = f.jobs[0];
  f.jobs.unshift(...Array.from({ length: 30 }, (_, i) => ({
    ...tv,
    id: i.toString(16).padStart(40, '0'),
    contentPath: `/completed/Movie ${i}`,
  })));
  f.recentIds.push(hash);
  assertEquals(await f.resolve(), [{ remote: '/completed', local: '/fixture-local' }]);
  assertEquals(f.recentReads(), 1);
  assertEquals(f.historyReads(), 1);
  f.history.clear();
  assertEquals(await f.resolve(), [], 'A recent hash alone never authorizes translation');
});

Deno.test('corroboration search is bounded and shared across roots', async () => {
  const f = fixture();
  f.jobs.splice(
    0,
    1,
    ...Array.from({ length: 30 }, (_, i) => ({
      ...f.jobs[0],
      id: i.toString(16).padStart(40, '0'),
    })),
  );
  f.access.push({ ...f.access[0], id: 'second' });
  f.candidates.push({ ...f.candidates[0], accessId: 'second' });
  assertEquals(await f.resolve(), []);
  assertEquals(f.historyReads(), 20);
  assertEquals(f.counts().manifestReads, 0);
});

Deno.test('explicit applicable QB mapping wins without additional reads', async () => {
  const f = fixture();
  f.target.pathMappings = [{
    id: 1,
    qbittorrentPath: '/completed',
    localPath: '/explicit',
    revision: 1,
    caseSensitive: true,
  }];
  assertEquals(await f.resolve(), [{ remote: '/completed', local: '/explicit', explicit: true }]);
  assertEquals(f.counts(), { endpointReads: 0, mappingReads: 0, manifestReads: 0 });
});

Deno.test('movie contexts share the twenty-witness budget and failed reads within one phase', async () => {
  const f = fixture();
  f.arr[0].instanceType = 'radarr';
  f.jobs.splice(
    0,
    1,
    ...Array.from({ length: 30 }, (_, i) => ({
      ...f.jobs[0],
      id: i.toString(16).padStart(40, '0'),
    })),
  );
  const witnesses: HistoricalQbWitnessCache = new Map();
  const resolve = (cache = witnesses) =>
    historicalQbTranslations(f.target, f.arr, f.access, f.candidates, f.jobs, new Map(), cache);
  for (let i = 0; i < 5; i++) {
    f.candidates[0].lineage.source = `/completed/Movie ${i}/Film.mkv`;
    assertEquals(await resolve(), []);
  }
  assertEquals(f.historyReads(), 20);
  assertEquals(f.recentReads(), 1);
  await resolve(new Map());
  assertEquals(f.historyReads(), 40, 'a fresh checkpoint must obtain fresh witnesses');
  let failures = 0;
  f.arr[0].client.historicalImportsForDownload = () => {
    failures++;
    return Promise.reject(new Error('synthetic unavailable history'));
  };
  const failed: HistoricalQbWitnessCache = new Map();
  await assertRejects(() => resolve(failed));
  await assertRejects(() => resolve(failed));
  assertEquals(
    failures,
    1,
    'failed relevant reads are shared too, never treated as empty evidence',
  );
});

Deno.test('host-scoped Sonarr mapping bridges different namespaces without a surviving lineage job', async () => {
  const f = fixture();
  f.jobs[0].id = 'unrelated';
  f.jobs[0].savePath = '/qb/storage';
  f.hints.push({ host: 'qb.fixture', remotePath: '/qb/storage', localPath: '/completed' });
  assertEquals(await f.resolve(), [{ remote: '/qb/storage', local: '/fixture-local' }]);
  assertEquals(f.counts().manifestReads, 0);
  f.hints[0].host = 'other.fixture';
  assertEquals(await f.resolve(), []);
});

Deno.test('identical paths or matching sizes alone never establish storage equivalence', async () => {
  for (const change of ['endpoint', 'hash', 'manifest', 'access', 'loopback']) {
    const f = fixture();
    if (change === 'endpoint') f.endpoints[0] = 'http://different.fixture:8080';
    if (change === 'hash') f.jobs[0].id = 'unrelated';
    if (change === 'manifest') f.jobs[0].manifestFiles[0].path = 'different.mkv';
    if (change === 'access') f.access[0].status = 'setup_needed';
    if (change === 'loopback') f.target.instanceUrl = f.endpoints[0] = 'http://localhost:8080';
    if (change === 'manifest') f.candidates.splice(1);
    assertEquals(await f.resolve(), [], change);
  }
});

Deno.test('conflicting verified roots and ambiguous Sonarr mappings fail closed', async () => {
  const f = fixture();
  f.hints.push({ host: 'qb.fixture', remotePath: '/qb', localPath: '/completed' }, {
    host: 'qb.fixture',
    remotePath: '/qb',
    localPath: '/completed/other',
  });
  await assertRejects(f.resolve, Error, 'Conflicting');
  f.hints.length = 0;
  f.access.push({
    ...f.access[0],
    id: 'other',
    configuration: { ...f.access[0].configuration, localRoot: '/different-storage' },
  });
  f.candidates.push({ ...f.candidates[0], accessId: 'other' });
  await assertRejects(f.resolve, Error, 'Conflicting');
});

Deno.test('configuration and manifest changes are re-read on every ownership checkpoint', async () => {
  const f = fixture();
  assertEquals((await f.resolve()).length, 1);
  f.endpoints[0] = 'http://different.fixture:8080';
  assertEquals(await f.resolve(), []);
  f.endpoints[0] = f.target.instanceUrl!;
  f.access[0].revision = 'changed';
  assertEquals(await f.resolve(), []);
  f.access[0].revision = 'one';
  f.jobs[0].filesTruncated = true;
  await assertRejects(f.resolve, Error, 'incomplete');
});

Deno.test({
  name:
    '23-file season: resolved unrelated job permits cleanup, active overlap vetoes exact files, unresolved ownership blocks',
  ignore: Deno.build.os !== 'linux',
  fn: async () => {
    Deno.env.set('DB_PATH', ':memory:');
    const { historicalJobClaims } = await import('./historicalDownloadPlanning.ts');
    const { historicalMountEntry } = await import('./historicalDownloadIdentity.ts');
    const root = await Deno.makeTempDir({ prefix: 'qb-translation-' });
    try {
      const f = fixture();
      f.access[0].configuration.localRoot = root;
      const mounts = await Deno.readTextFile('/proc/self/mountinfo');
      for (const [i, candidate] of f.candidates.entries()) {
        candidate.filesystem.entry =
          historicalMountEntry(`${root}/Manhattan/${i}.mkv`, mounts).entry;
      }
      unrelatedLiveImport(f);
      const claims = () =>
        historicalJobClaims(
          f.candidates,
          [f.target],
          f.access,
          f.arr,
        );
      assertEquals([...await claims()], []);
      assertEquals(f.counts(), { endpointReads: 1, mappingReads: 1, manifestReads: 1 });
      assertEquals(f.historyReads(), 1);
      f.jobs[0].manifestFiles.push({ path: 'Manhattan/4.mkv', size: 7 });
      f.jobs[0].fileCount++;
      f.jobs[0].state = 'downloading';
      assertEquals([...await claims()], ['4']);
      f.jobs[0].savePath = '/qb-only';
      f.jobs[0].contentPath = '/qb-only/Petals on the Wind';
      f.hints.push({ host: 'qb.fixture', remotePath: '/qb-only', localPath: '/completed' });
      assertEquals(
        [...await claims()],
        ['4'],
        'Translated overlap protects different namespaces too',
      );
      f.hints.length = 0;
      await assertRejects(claims, Error, 'Ordinary service deletion is still available');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
