import { assertEquals } from '@std/assert';
import { parseHistoricalImports } from '../../integrations/arr/historicalImports.ts';
import { historicalDownloadLineage } from './historicalDownloadLineage.ts';
import { historicalDownloadCoverage } from './historicalDownloadCoverage.ts';
import type { HistoricalAccessStatus } from '../../../../shared/historicalDownloads.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import type { ServiceOwnedPlan } from './serviceOwnedPlanning.ts';

// Sanitized shape observed in older Sonarr imports: exact paths/fileId, no size key.
const row = (episodeId = 1) => ({
  id: episodeId,
  seriesId: 10,
  episodeId,
  eventType: 'downloadFolderImported',
  date: '2021-12-26T05:43:52Z',
  downloadId: 'fixture-job',
  data: {
    fileId: '20',
    droppedPath: '/completed/season/shared.mkv',
    importedPath: '/tv/season/shared.mkv',
    downloadClient: 'qBittorrent',
    downloadClientName: 'QBittorrent',
    preferredWordScore: '0',
  },
});

function fixture() {
  let mappingReads = 0;
  const history = parseHistoricalImports([row(), row(2)], 10);
  const job = {
    id: 'fixture-job',
    savePath: '/payload',
    contentPath: '/payload/season',
    fileCount: 1,
    filesTruncated: false,
    manifestFiles: [{ path: 'season/shared.mkv', size: 7 }],
  } as DownloadJob;
  const service = {
    instanceId: 1,
    instanceType: 'sonarr',
    client: {
      qbittorrentEndpoints: () => Promise.resolve(['http://qb.fixture:8080']),
      remotePathHints: () => {
        mappingReads++;
        return Promise.resolve([
          { host: 'qb.fixture', remotePath: '/payload', localPath: '/completed' },
        ]);
      },
    },
  } as unknown as ArrDeleteTarget;
  const target = {
    provider: 'qbittorrent',
    instanceKey: 'qb:1',
    instanceUrl: 'http://qb.fixture:8080',
    client: {
      findJob: () => {
        throw new Error('Manifest already collected');
      },
      deleteJob: () => {
        throw new Error('Coverage must never execute');
      },
    },
  } as unknown as DownloadClientTarget;
  const access = [{
    id: 'access',
    instanceId: 1,
    revision: 'one',
    status: 'available',
    configuration: {
      enabled: true,
      remoteRoot: '/completed',
      localRoot: '/downloads',
      noRemainingClient: false,
    },
  }] as HistoricalAccessStatus[];
  const plan = {
    qbSelected: true,
    actions: [{
      id: 'action',
      instanceKey: 'qb:1',
      service: 'qb',
      presence: 'current',
      effectsComplete: true,
      job,
      files: [{ path: '/payload/season/shared.mkv', size: 7 }],
    }],
    retention: { decisions: [{ actionId: 'action', requested: true, state: 'delete_candidate' }] },
  } as ServiceOwnedPlan;
  const resolve = (plans = [plan]) =>
    historicalDownloadCoverage(
      history,
      new Set([1, 2]),
      service,
      plans,
      [target],
      access,
      new Map(),
    );
  return { history, job, service, target, access, plan, resolve, reads: () => mappingReads };
}

Deno.test('Radarr current movie sources use exact selected QB coverage across namespaces', async () => {
  const f = fixture();
  f.service.instanceType = 'radarr';
  const history = parseHistoricalImports(
    [{
      ...row(),
      movieId: 7,
      data: { ...row().data, fileId: '42' },
    }],
    7,
    'radarr',
  );
  const resolve = () =>
    historicalDownloadCoverage(
      history,
      new Set([7]),
      f.service,
      [f.plan],
      [f.target],
      f.access,
      new Map(),
    );
  assertEquals(await resolve(), [{
    source: row().data.droppedPath,
    service: 'qb',
    actionIds: ['action'],
  }]);
  f.plan.qbSelected = false;
  assertEquals(await resolve(), []);
  f.plan.qbSelected = true;
  f.plan.actions[0].retainedOwnership = true;
  assertEquals(await resolve(), []);
  delete f.plan.actions[0].retainedOwnership;
  f.job.filesTruncated = true;
  assertEquals(await resolve(), []);
});

Deno.test('selected eligible QB covers exact paths despite missing history size; shared records count once', async () => {
  const f = fixture();
  assertEquals(f.history.records.length, 2);
  assertEquals(f.history.problems.length, 0);
  assertEquals(await f.resolve(), [{
    source: '/completed/season/shared.mkv',
    service: 'qb',
    actionIds: ['action'],
  }]);
  assertEquals(f.reads(), 1);
});

Deno.test('unchecked, blocked, shared retained, incomplete and conflicting selections never claim coverage', async () => {
  for (
    const change of [
      'unchecked',
      'held',
      'retained',
      'incomplete',
      'other-plan',
      'manifest',
      'path',
      'mapping',
    ]
  ) {
    const f = fixture();
    const plans = [f.plan];
    if (change === 'unchecked') f.plan.qbSelected = false;
    if (change === 'held') f.plan.retention.decisions[0].state = 'held';
    if (change === 'retained') f.plan.actions[0].retainedOwnership = true;
    if (change === 'incomplete') f.plan.actions[0].effectsComplete = false;
    if (change === 'other-plan') {
      const other = structuredClone(f.plan);
      other.retention.decisions[0].state = 'kept';
      plans.push(other);
    }
    if (change === 'manifest') f.job.filesTruncated = true;
    if (change === 'path') f.plan.actions[0].files[0].path = '/payload/season/different.mkv';
    if (change === 'mapping') {
      f.target.pathMappings = [{
        qbittorrentPath: '/payload',
        localPath: '/elsewhere',
      }] as DownloadClientTarget['pathMappings'];
    }
    assertEquals(await f.resolve(plans), [], change);
  }
});

Deno.test('mixed sources: missing-size imports still require current lineage for untracked cleanup', async () => {
  const f = fixture();
  const untracked = row(3);
  untracked.data.droppedPath = '/completed/old/untracked.mkv';
  const history = parseHistoricalImports([row(), row(2), untracked], 10);
  const coverage = await historicalDownloadCoverage(
    history,
    new Set([1, 2, 3]),
    f.service,
    [f.plan],
    [f.target],
    f.access,
    new Map(),
  );
  assertEquals(coverage.length, 1);
  const lineage = historicalDownloadLineage(
    history,
    { files: [], episodes: [] },
    new Set([1, 2, 3]),
  );
  assertEquals(lineage.candidates, []);
  assertEquals(lineage.skipped, [
    {
      source: '/completed/season/shared.mkv',
      reason: 'Exact current import lineage or complete ownership could not be verified',
    },
    {
      source: '/completed/old/untracked.mkv',
      reason: 'Exact current import lineage or complete ownership could not be verified',
    },
  ]);
});

Deno.test('malformed and conflicting fields retain independent exact paths but cannot authorize cleanup', () => {
  for (
    const [fields, reason] of [
      [{ fileId: 'invalid', size: '7' }, 'Malformed imported file ID'],
      [{ importedPath: '../unsafe', size: '7' }, 'Missing or invalid exact import path'],
    ] as const
  ) {
    const record = row();
    const history = parseHistoricalImports(
      [{ ...record, data: { ...record.data, ...fields } }],
      10,
    );
    assertEquals(history.records, []);
    assertEquals(history.problems[0].droppedPath, record.data.droppedPath);
    assertEquals(history.problems[0].reason, reason);
  }
  const invalid = row();
  invalid.data.droppedPath = '../unsafe';
  assertEquals(parseHistoricalImports([invalid], 10).problems[0].droppedPath, undefined);
});

Deno.test('season-wide coverage shares translation reads across 100 source paths', async () => {
  const f = fixture();
  const rows = Array.from({ length: 100 }, (_, i) => {
    const r = row(i + 1);
    r.data.droppedPath = `/completed/season/${i}.mkv`;
    return r;
  });
  f.job.manifestFiles = rows.map((_, i) => ({ path: `season/${i}.mkv`, size: 7 }));
  f.job.fileCount = 100;
  f.plan.actions[0].files = rows.map((_, i) => ({ path: `/payload/season/${i}.mkv`, size: 7 }));
  const result = await historicalDownloadCoverage(
    parseHistoricalImports(rows, 10),
    new Set(rows.map((r) => r.episodeId)),
    f.service,
    [f.plan],
    [f.target],
    f.access,
    new Map(),
  );
  assertEquals(result.length, 100);
  assertEquals(f.reads(), 1);
});
