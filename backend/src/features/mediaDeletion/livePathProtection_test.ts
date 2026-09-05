import { assertEquals, assertRejects } from '@std/assert';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import { assertLocalDeletionPathsUnowned } from './livePathProtection.ts';

// These unit fixtures describe an accessible virtual media mount.
const realPath = Deno.realPath;
Deno.realPath = (path) => {
  const local = String(path).replaceAll('\\', '/');
  return /^(?:[A-Za-z]:)?\/(local|tv)(\/|$)/.test(local) ? Promise.resolve(local) : realPath(path);
};

const job: DownloadJob = {
  id: 'torrent',
  name: 'Episode',
  state: 'uploading',
  size: 10,
  uploaded: 0,
  completedAt: null,
  ratio: null,
  seedingTime: 0,
  trackerHost: null,
  contentPath: '/qb/Show/episode.mkv',
  savePath: '/qb',
  fileCount: 1,
  files: [{ path: 'Show/episode.mkv', size: 10 }],
  manifestFiles: [{ path: 'Show/episode.mkv', size: 10 }],
  filesTruncated: false,
};
function target(): DownloadClientTarget {
  return {
    provider: 'qbittorrent',
    instanceKey: 'qb:1',
    instanceName: 'QB',
    instanceId: 1,
    configurationIdentity: 'test',
    pathMappings: [{
      id: 1,
      qbittorrentPath: '/qb',
      localPath: '/local',
      caseSensitive: true,
      revision: 1,
    }],
    client: {
      listJobSummaries: () => Promise.resolve([job]),
      findJob: () => Promise.resolve(job),
      deleteJob: () => {
        throw new Error('never delete');
      },
      discoverJobs: () => Promise.resolve({ jobs: [job], summaryFingerprint: 'test' }),
    },
  };
}

Deno.test('no QB connection imposes no path mapping or ownership veto', async () => {
  await assertLocalDeletionPathsUnowned([{ path: '/unmapped/file' }], []);
});

Deno.test('missing local deletion paths cannot establish nonownership', async () => {
  await assertRejects(
    () =>
      assertLocalDeletionPathsUnowned([{ path: '/absent-ownership-test/file.mkv' }], [target()]),
    Error,
    'Plex Librarian cannot access the mapped local path "/absent-ownership-test/file.mkv" to check qBittorrent ownership',
  );
});

Deno.test('reconciliation permits removed files only beneath a still-accessible accepted root', async () => {
  const root = await Deno.makeTempDir();
  const client = target();
  client.client.listJobSummaries = () => Promise.resolve([]);
  try {
    await assertLocalDeletionPathsUnowned([{ path: `${root}/removed.mkv`, verifiedRoot: root }], [
      client,
    ]);
    await assertRejects(() =>
      assertLocalDeletionPathsUnowned([{ path: `${root}/removed.mkv` }], [client])
    );
    await assertRejects(() =>
      assertLocalDeletionPathsUnowned([{
        path: `${root}/missing/removed.mkv`,
        verifiedRoot: `${root}/missing`,
      }], [client])
    );
  } finally {
    await Deno.remove(root);
  }
});

Deno.test('live QB exact entry and files inside a deleted folder are protected without history', async () => {
  for (
    const path of [{ path: '/local/Show/episode.mkv' }, { path: '/local/Show', directory: true }]
  ) {
    await assertRejects(
      () => assertLocalDeletionPathsUnowned([path], [target()]),
      Error,
      'Retained because',
    );
    await assertLocalDeletionPathsUnowned([path], [target()], new Set(['qb:1:torrent']));
  }
});

Deno.test('another library directory entry stays deletable even with a matching basename', async () => {
  await assertLocalDeletionPathsUnowned([{ path: '/local/Library/episode.mkv' }], [target()]);
  await assertLocalDeletionPathsUnowned([{ path: '/local/Showcase', directory: true }], [target()]);
});

Deno.test('unknown mappings, incomplete manifests and offline clients fail closed', async () => {
  const unmapped = target();
  unmapped.pathMappings = [];
  const incomplete = target();
  incomplete.client.discoverJobs = () =>
    Promise.resolve({ jobs: [{ ...job, filesTruncated: true }], summaryFingerprint: '' });
  const offline = target();
  offline.client.listJobSummaries = () => Promise.reject(new Error('offline'));
  for (const client of [unmapped, incomplete, offline]) {
    await assertRejects(() =>
      assertLocalDeletionPathsUnowned([{ path: '/local/Show', directory: true }], [client])
    );
  }
});

Deno.test('selected job authorization is scoped to its QB instance', async () => {
  const second = { ...target(), instanceKey: 'qb:2' };
  await assertRejects(
    () =>
      assertLocalDeletionPathsUnowned(
        [{ path: '/local/Show', directory: true }],
        [target(), second],
        new Set(['qb:1:torrent']),
      ),
    Error,
    'Retained because',
  );
});

Deno.test('folder discovery inspects the intersecting live content path', async () => {
  const client = target();
  client.client.discoverJobs = (candidates) => {
    assertEquals(candidates, [{
      path: '/qb/Show/episode.mkv',
      caseSensitive: true,
      directory: true,
    }]);
    return Promise.resolve({ jobs: [], summaryFingerprint: '' });
  };
  await assertLocalDeletionPathsUnowned([{ path: '/local/Show', directory: true }], [client]);
});

Deno.test('QB needs only its download mapping, not a mapping for the library', async () => {
  const client = target();
  let manifestReads = 0;
  client.client.discoverJobs = () => {
    manifestReads++;
    throw new Error('Unrelated library files do not require torrent manifests');
  };
  await assertLocalDeletionPathsUnowned([{ path: '/tv/Show', directory: true }], [client]);
  assertEquals(manifestReads, 0);
});

Deno.test('a parent deletion protects mapped download files nested below it', async () => {
  await assertRejects(
    () => assertLocalDeletionPathsUnowned([{ path: '/', directory: true }], [target()]),
    Error,
    'Retained because',
  );
});

Deno.test('an empty live QB client requires no hypothetical storage mappings', async () => {
  const client = target();
  client.pathMappings = [];
  client.client.listJobSummaries = () => Promise.resolve([]);
  await assertLocalDeletionPathsUnowned([{ path: '/tv/Show', directory: true }], [client]);
});

Deno.test('a new live download appearing during inspection cannot bypass protection', async () => {
  const client = target();
  let calls = 0;
  client.client.listJobSummaries = () => Promise.resolve(++calls === 1 ? [] : [job]);
  await assertRejects(
    () => assertLocalDeletionPathsUnowned([{ path: '/tv/Show' }], [client]),
    Error,
    'changed during',
  );
});
