import { assertEquals, assertRejects } from '@std/assert';
import { resolve } from '@std/path';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import type { VersionStorageEvidence } from './versionStorageEvidence.ts';

const temporary = await Deno.makeTempDir();
Deno.env.set('DB_PATH', resolve(temporary, 'version-storage.db'));
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(Deno.env.get('DB_PATH')!, resolve(import.meta.dirname!, '../../../drizzle'));
const { assertVersionStoragePathsUnowned, captureVersionStorageEvidence } = await import(
  './versionStorageEvidence.ts'
);
const { evidenceFingerprint } = await import('./serviceStorage.ts');

function fixture() {
  const root = {
    serverId: 1,
    configurationIdentity: 'plex-config',
    caseSensitive: true,
    hasAliases: false,
    revision: 1,
  };
  const evidence: VersionStorageEvidence = {
    serverId: 1,
    libraryKey: '1',
    roots: [
      { ...root, id: 1, serviceKey: 'plex:1', serviceRoot: '/library', storageRoot: '/host/media' },
      { ...root, id: 2, serviceKey: 'qb:1', serviceRoot: '/downloads', storageRoot: '/host/media' },
    ],
    connections: [{
      key: 'qb:1',
      name: 'QB',
      configurationIdentity: evidenceFingerprint('qb-config'),
      libraryKeys: ['1'],
      roots: [],
    }],
  };
  const job: DownloadJob = {
    id: 'job',
    name: 'job',
    state: 'stoppedUP',
    size: 1,
    uploaded: 0,
    completedAt: 1,
    ratio: 0,
    seedingTime: 0,
    contentPath: '/downloads/show',
    savePath: '/downloads',
    trackerHost: null,
    fileCount: 1,
    files: [],
    filesTruncated: false,
    manifestFiles: [{ path: 'show/retained.mkv', size: 1 }],
  };
  const target: DownloadClientTarget = {
    provider: 'qbittorrent',
    instanceKey: '1',
    configurationIdentity: 'qb-config',
    instanceId: 1,
    instanceName: 'QB',
    client: {
      scanJobSummaries: async (visit) => {
        await visit(job);
        return 'stable';
      },
      findJob: () => Promise.resolve(job),
      deleteJob: () => {
        throw new Error('Must never delete from ownership checks');
      },
    },
  };
  return { evidence, target, job };
}

Deno.test('version storage preserves legacy setup when no service root exists', async () => {
  assertEquals(await captureVersionStorageEvidence(1, '1'), undefined);
});

Deno.test('version storage ownership supports different service prefixes and blocks shared entries', async () => {
  const { evidence, target } = fixture();
  await assertVersionStoragePathsUnowned(evidence, ['/library/show/duplicate.mkv'], [target]);
  await assertRejects(
    () => assertVersionStoragePathsUnowned(evidence, ['/library/show/retained.mkv'], [target]),
    Error,
    'retained download owns',
  );
});

Deno.test('version storage keeps distinct download copies independent', async () => {
  const { evidence, target } = fixture();
  evidence.roots[1].storageRoot = '/host/separate-downloads';
  await assertVersionStoragePathsUnowned(evidence, ['/library/show/retained.mkv'], [target]);
});

Deno.test('version storage fails closed for missing, ambiguous and aliased namespaces', async () => {
  for (const problem of ['missing', 'ambiguous', 'aliases'] as const) {
    const { evidence, target } = fixture();
    if (problem === 'missing') evidence.roots.pop();
    if (problem === 'ambiguous') evidence.roots.push({ ...evidence.roots[0], id: 3 });
    if (problem === 'aliases') evidence.roots[0].hasAliases = true;
    await assertRejects(() =>
      assertVersionStoragePathsUnowned(evidence, ['/library/show/duplicate.mkv'], [target])
    );
  }
});

Deno.test('version storage fails closed for incomplete or unavailable download evidence', async () => {
  for (const problem of ['truncated', 'count', 'empty', 'unavailable', 'changed'] as const) {
    const { evidence, target, job } = fixture();
    if (problem === 'truncated') job.filesTruncated = true;
    if (problem === 'count') job.fileCount = 2;
    if (problem === 'empty') {
      job.fileCount = 0;
      job.manifestFiles = [];
    }
    if (problem === 'unavailable') target.client.scanJobSummaries = undefined;
    if (problem === 'changed') {
      let calls = 0;
      target.client.scanJobSummaries = async (visit) => {
        await visit(job);
        return String(calls++);
      };
    }
    await assertRejects(() =>
      assertVersionStoragePathsUnowned(evidence, ['/library/show/duplicate.mkv'], [target])
    );
  }
});

Deno.test('version storage rejects changed or added download client configurations', async () => {
  const { evidence, target } = fixture();
  target.configurationIdentity = 'changed';
  await assertRejects(
    () => assertVersionStoragePathsUnowned(evidence, ['/library/show/duplicate.mkv'], [target]),
    Error,
    'download clients changed',
  );
  await assertRejects(
    () => assertVersionStoragePathsUnowned(evidence, ['/library/show/duplicate.mkv'], []),
    Error,
    'download clients changed',
  );
});
