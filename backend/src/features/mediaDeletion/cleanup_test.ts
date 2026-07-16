import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { ArrClient } from '../../integrations/arr/client.ts';
import { QbittorrentDownloadClient } from '../../integrations/qbittorrent/adapter.ts';
import { QbittorrentClient } from '../../integrations/qbittorrent/client.ts';
import {
  executeDownloadedFileCleanup,
  reconcileSharedDownloadCleanups,
  type ResolvedCleanupItem,
  resolveDownloadCleanup,
  selectDirectOrphanFiles,
  selectVerifiedDownloadCleanups,
} from './cleanup.ts';
import { downloadJobOwnsPath, downloadPayloadIsExclusivelyOwned } from './ownership.ts';

const hash = 'a'.repeat(40);

Deno.test('live torrent ownership requires an exact manifest path, not only the hash', () => {
  const torrent = {
    contentPath: '/downloads/new-release',
    savePath: '/downloads',
    manifestFiles: [{ path: 'new-release/movie.mkv', size: 100 }],
  };
  assertEquals(downloadJobOwnsPath(torrent, '/downloads/new-release/movie.mkv'), true);
  assertEquals(downloadJobOwnsPath(torrent, '/downloads/old-release/movie.mkv'), false);
});

Deno.test('torrent payload deletion requires every manifest file to belong to the title', () => {
  const torrent = {
    contentPath: '/downloads/collection',
    savePath: '/downloads',
    manifestFiles: [
      { path: 'collection/selected.mkv', size: 100 },
      { path: 'collection/other.mkv', size: 100 },
    ],
  };
  assertEquals(
    downloadPayloadIsExclusivelyOwned(torrent, new Set(['/downloads/collection/selected.mkv'])),
    false,
  );
  assertEquals(
    downloadPayloadIsExclusivelyOwned(
      torrent,
      new Set([
        '/downloads/collection/selected.mkv',
        '/downloads/collection/other.mkv',
      ]),
    ),
    true,
  );
});

Deno.test('live torrent ownership supports Windows qBittorrent paths', () => {
  assertEquals(
    downloadJobOwnsPath({
      contentPath: 'D:\\Downloads\\Release',
      savePath: 'D:\\Downloads',
      manifestFiles: [{ path: 'Release\\Movie.mkv', size: 100 }],
    }, 'd:\\downloads\\release\\movie.mkv'),
    true,
  );
});

Deno.test('absolute manifest paths cannot claim ownership outside the torrent roots', () => {
  const torrent = {
    contentPath: '/downloads/unrelated-release',
    savePath: '/downloads',
    manifestFiles: [{ path: '/downloads/historical/movie.mkv', size: 100 }],
  };
  const sourcePaths = new Set(['/downloads/historical/movie.mkv']);
  assertEquals(downloadJobOwnsPath(torrent, '/downloads/historical/movie.mkv'), false);
  assertEquals(downloadPayloadIsExclusivelyOwned(torrent, sourcePaths), false);
});

Deno.test('torrent ownership suppresses only the exact orphan path sharing its hash', () => {
  const current = {
    hash,
    path: '/local/current/movie.mkv',
    remotePath: '/downloads/current/movie.mkv',
  };
  const old = {
    hash,
    path: '/local/old/movie.mkv',
    remotePath: '/downloads/old/movie.mkv',
  };
  const torrent = {
    jobId: hash,
    contentPath: '/downloads/current',
    savePath: '/downloads',
    manifestFiles: [{ path: 'current/movie.mkv', size: 100 }],
  };
  assertEquals(
    selectDirectOrphanFiles(
      [current, old] as unknown as Parameters<typeof selectDirectOrphanFiles>[0],
      [torrent] as unknown as Parameters<typeof selectDirectOrphanFiles>[1],
    ).map((file) => file.path),
    ['/local/old/movie.mkv'],
  );
});

Deno.test('complete downloaded-file execution marks and deletes torrents before orphan files', async () => {
  const calls: string[] = [];
  const cleanup = {
    downloadJobs: [{
      provider: 'qbittorrent',
      instanceKey: 'db:1',
      jobId: hash,
      contentPath: '/downloads/release',
      savePath: '/downloads',
      manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
      authorizedSourcePaths: ['/downloads/release/movie.mkv'],
      target: {
        client: {
          findJob: () =>
            Promise.resolve({
              id: hash,
              contentPath: '/downloads/release',
              savePath: '/downloads',
              manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
            }),
          deleteJob: (value: string) => {
            calls.push(`torrent:${value}`);
            return Promise.resolve();
          },
        },
      },
    }],
    orphanFiles: [{ path: '/downloads/release/movie.idx' }],
  } as unknown as ResolvedCleanupItem;
  await executeDownloadedFileCleanup(
    cleanup,
    new Set(),
    new Set(),
    (_torrent, key) => {
      calls.push(`mark:${key}`);
      return Promise.resolve();
    },
    (file) => {
      calls.push(`orphan:${file.path}`);
      return Promise.resolve();
    },
  );
  assertEquals(calls, [
    `mark:db:1:${hash}`,
    `torrent:${hash}`,
    'orphan:/downloads/release/movie.idx',
  ]);
});

Deno.test('execution refuses a hash re-added with a different manifest', async () => {
  let deleted = false;
  const cleanup = {
    downloadJobs: [{
      provider: 'qbittorrent',
      instanceKey: 'db:1',
      jobId: hash,
      contentPath: '/downloads/release',
      savePath: '/downloads',
      manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
      authorizedSourcePaths: ['/downloads/release/movie.mkv'],
      target: {
        client: {
          findJob: () =>
            Promise.resolve({
              id: hash,
              contentPath: '/downloads/re-added',
              savePath: '/downloads',
              manifestFiles: [{ path: 're-added/unrelated.mkv', size: 100 }],
            }),
          deleteJob: () => {
            deleted = true;
            return Promise.resolve();
          },
        },
      },
    }],
    orphanFiles: [],
  } as unknown as ResolvedCleanupItem;

  await assertRejects(
    () => executeDownloadedFileCleanup(cleanup, new Set(), new Set()),
    Error,
    'changed since verification',
  );
  assertEquals(deleted, false);
});

function arrTarget(historyMovieIds: number[] = [7]) {
  const client = new ArrClient(
    'radarr',
    'http://radarr',
    'key',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/movie?tmdbId=')) {
        return Promise.resolve(Response.json([{
          id: 7,
          title: 'Movie',
          path: 'A:\\Movies\\Movie',
        }]));
      }
      if (url.includes('/extrafile?movieId=')) {
        return Promise.resolve(Response.json([
          { relativePath: 'Movie.idx', type: 'subtitle' },
          { relativePath: 'Movie.sub', type: 'subtitle' },
        ]));
      }
      if (url.includes('/moviefile?movieId=')) {
        return Promise.resolve(Response.json([
          { relativePath: 'Movie.mov', size: 100 },
        ]));
      }
      if (url.includes('/history?')) {
        return Promise.resolve(Response.json({
          totalRecords: historyMovieIds.length,
          records: historyMovieIds.map((movieId) => ({ movieId })),
        }));
      }
      return Promise.resolve(Response.json([{
        eventType: 'downloadFolderImported',
        downloadId: hash,
        data: { droppedPath: '/downloads/release/movie.mkv' },
      }]));
    }) as typeof fetch,
  );
  return {
    instanceId: 1,
    instanceName: 'Radarr',
    client,
    addImportExclusion: true,
    pathMappings: [],
  };
}

function qbitTarget(
  loginResponse = new Response('Ok.', {
    headers: { 'Set-Cookie': 'SID=abc; path=/' },
  }),
  release = 'release',
) {
  const client = new QbittorrentClient(
    'http://qbit:8080',
    'user',
    'pass',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/app/version')) {
        return Promise.resolve(new Response('Forbidden', { status: 403 }));
      }
      if (url.endsWith('/auth/login')) return Promise.resolve(loginResponse.clone());
      if (url.includes('/torrents/info')) {
        return Promise.resolve(Response.json([{
          hash,
          name: 'Release',
          size: 100,
          content_path: `/downloads/${release}`,
          save_path: '/downloads',
          tracker: 'https://tracker.example/private-passkey',
        }]));
      }
      return Promise.resolve(Response.json([{ name: `${release}/movie.mkv`, size: 100 }]));
    }) as typeof fetch,
  );
  return {
    provider: 'qbittorrent',
    instanceKey: 'db:1',
    instanceId: 1,
    instanceName: 'qBittorrent',
    client: new QbittorrentDownloadClient(client),
  };
}

Deno.test('torrent cleanup resolves Arr import history to live redacted qBittorrent details', async () => {
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget()],
  );
  assertEquals(result.status, 'resolved');
  assertEquals(result.downloadJobs[0]?.jobId, hash);
  assertEquals(result.downloadJobs[0]?.sourcePath, '/downloads/release/movie.mkv');
  assertEquals(result.downloadJobs[0]?.trackerHost, 'tracker.example');
  assertEquals(result.arrStatus, 'resolved');
  assertEquals(result.arrTargets, [{
    instanceName: 'Radarr',
    type: 'radarr',
    title: 'Movie',
    path: 'A:\\Movies\\Movie',
    mediaFiles: [{ relativePath: 'Movie.mov', size: 100 }],
    extraFiles: [
      { relativePath: 'Movie.idx', type: 'subtitle' },
      { relativePath: 'Movie.sub', type: 'subtitle' },
    ],
  }]);
  assertEquals(result.sources, [{
    instanceName: 'Radarr',
    downloadId: hash,
    path: '/downloads/release/movie.mkv',
    importedPath: null,
    verification: 'unverified',
    reason: 'No download path mapping covers this path',
  }]);
});

Deno.test('a re-added torrent at a different path is not selected by hash', async () => {
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget(undefined, 'different-release')],
  );
  assertEquals(result.downloadJobs, []);
  assertStringIncludes(result.reason ?? '', 'manifest does not own');
});

Deno.test('a torrent associated with an unselected Arr title is retained', async () => {
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget([7, 99])],
    [qbitTarget()],
  );
  assertEquals(result.downloadJobs, []);
  assertStringIncludes(result.reason ?? '', 'not all attributable');
  assertStringIncludes(result.retainedPaths[0]?.reason ?? '', 'another title');
});

Deno.test('torrent cleanup errors instead of silently skipping an unreachable client', async () => {
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget(new Response('Fails.'))],
  );
  assertEquals(result.status, 'error');
  assertStringIncludes(result.reason ?? '', 'qBittorrent login failed');
});

Deno.test('partial batch selection keeps only fully verified qBittorrent cleanups', async () => {
  const verified = await resolveDownloadCleanup(
    'verified',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget()],
  );
  const failed = await resolveDownloadCleanup(
    'failed',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget(new Response('Fails.'))],
  );
  assertEquals([...selectVerifiedDownloadCleanups([verified, failed]).keys()], ['verified']);
});

Deno.test('a torrent retained by one selected title is retained for the whole batch', () => {
  const torrent = {
    instanceKey: 'db:1',
    jobId: hash,
    contentPath: '/downloads/shared',
    savePath: '/downloads',
  };
  const eligible = {
    ratingKey: 'eligible',
    status: 'resolved',
    downloadJobs: [torrent],
    orphanFiles: [],
    retainedPaths: [],
    observedDownloadJobKeys: new Set([`db:1:${hash}`]),
  } as unknown as ResolvedCleanupItem;
  const conflicting = {
    ratingKey: 'conflicting',
    status: 'error',
    reason: 'Another configured client failed',
    downloadJobs: [torrent],
    orphanFiles: [],
    retainedPaths: [],
    observedDownloadJobKeys: new Set([`db:1:${hash}`]),
  } as unknown as ResolvedCleanupItem;

  const reconciled = reconcileSharedDownloadCleanups([eligible, conflicting]);
  assertEquals(reconciled[0]?.status, 'unavailable');
  assertEquals(reconciled[0]?.downloadJobs, []);
  assertStringIncludes(reconciled[0]?.retainedPaths[0]?.reason ?? '', 'selected title');
  assertEquals(reconciled[1]?.status, 'error');
});

Deno.test('torrent cleanup resumes when a previously attempted torrent is now absent', async () => {
  const target = qbitTarget();
  const absentClient = new QbittorrentClient(
    'http://qbit:8080',
    '',
    '',
    ((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith('/app/version') ? new Response('v5.1.2') : Response.json([]),
      )) as typeof fetch,
  );
  target.client = new QbittorrentDownloadClient(absentClient);
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [target],
    new Set([`db:1:${hash}`]),
  );
  assertEquals(result.status, 'resolved');
  assertEquals(result.downloadJobs, []);
  assertStringIncludes(result.reason ?? '', 'previously started');
});

Deno.test('cleanup remains resumable after the attempted Arr record is also absent', async () => {
  const arr = arrTarget();
  arr.client = new ArrClient(
    'radarr',
    'http://radarr',
    'key',
    (() => Promise.resolve(Response.json([]))) as typeof fetch,
  );
  const target = qbitTarget();
  target.client = new QbittorrentDownloadClient(
    new QbittorrentClient(
      'http://qbit:8080',
      '',
      '',
      ((input: string | URL | Request) =>
        Promise.resolve(
          String(input).endsWith('/app/version') ? new Response('v5.1.2') : Response.json([]),
        )) as typeof fetch,
    ),
  );
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arr],
    [target],
    new Set([`db:1:${hash}`]),
    [],
    new Set([arr.instanceId]),
  );
  assertEquals(result.status, 'resolved');
  assertEquals(result.arrStatus, 'resolved');
  assertEquals(result.arrTargets, []);
});

Deno.test('optional history and extra-file failures do not block verified Arr deletion', async () => {
  const client = new ArrClient(
    'radarr',
    'http://radarr',
    'key',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/movie?tmdbId=')) {
        return Promise.resolve(Response.json([{
          id: 7,
          title: 'Movie',
          path: '/movies/Movie',
        }]));
      }
      return Promise.resolve(new Response('Unavailable', { status: 503 }));
    }) as typeof fetch,
  );
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [{
      instanceId: 1,
      instanceName: 'Radarr',
      client,
      addImportExclusion: true,
      pathMappings: [],
    }],
    [],
  );
  assertEquals(result.arrStatus, 'resolved');
  assertEquals(result.arrTargets[0]?.path, '/movies/Movie');
  assertEquals(result.arrTargets[0]?.mediaFiles, null);
  assertEquals(result.arrTargets[0]?.extraFiles, null);
  assertEquals(result.status, 'unavailable');
});
