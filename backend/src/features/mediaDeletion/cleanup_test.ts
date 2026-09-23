import { assertEquals, assertStringIncludes } from '@std/assert';
import { ArrClient } from '../../integrations/arr/client.ts';
import { QbittorrentDownloadClient } from '../../integrations/qbittorrent/adapter.ts';
import { QbittorrentClient } from '../../integrations/qbittorrent/client.ts';
import { resolveDownloadCleanup } from './cleanup.ts';
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
          { relativePath: 'Movie.idx', type: 'subtitle', movieFileId: null },
          { relativePath: 'Movie.sub', type: 'subtitle', movieFileId: null },
        ]));
      }
      if (url.includes('/moviefile?movieId=')) {
        return Promise.resolve(Response.json([
          { relativePath: 'Movie.mov', size: 100 },
        ]));
      }
      if (url.includes('/history?')) {
        assertEquals(new URL(url).searchParams.get('downloadId'), hash.toUpperCase());
        return Promise.resolve(Response.json({
          totalRecords: historyMovieIds.length,
          records: historyMovieIds.map((movieId, index) => ({
            id: index + 1,
            movieId,
            downloadId: hash.toUpperCase(),
          })),
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
    instanceType: 'radarr' as const,
    instanceUrl: 'http://radarr',
    configurationUpdatedAt: 1,
    mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
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
          total_size: 100,
          content_path: `/downloads/${release}`,
          save_path: '/downloads',
          tracker: 'https://tracker.example/private-passkey',
        }]));
      }
      return Promise.resolve(
        Response.json([{ index: 0, name: `${release}/movie.mkv`, size: 100 }]),
      );
    }) as typeof fetch,
  );
  return {
    provider: 'qbittorrent',
    instanceKey: 'db:1',
    configurationIdentity: 'db:1:100:https://downloads.example',
    instanceId: 1,
    instanceName: 'qBittorrent',
    client: new QbittorrentDownloadClient(client),
  };
}

function partialShowTargets(options: {
  shared?: boolean;
  historyFailure?: boolean;
  exclusivityFailure?: boolean;
  ownsSource?: boolean;
  radarr?: boolean;
  manifestFiles?: Array<{ path: string; size: number | null }>;
} = {}) {
  const sourcePath = options.ownsSource === false
    ? '/downloads/other/episode-1.mkv'
    : '/downloads/release/episode-1.mkv';
  const manifestFiles = options.manifestFiles ?? [
    { path: 'release/episode-1.mkv', size: 100 },
    { path: 'release/episode-2.mkv', size: 100 },
  ];
  const arr = {
    instanceId: 2,
    instanceName: 'Sonarr',
    instanceType: options.radarr ? 'radarr' as const : 'sonarr' as const,
    instanceUrl: 'http://sonarr',
    configurationUpdatedAt: 10,
    mappingIdentity: 'mapping',
    addImportExclusion: false,
    pathMappings: [],
    client: {
      type: options.radarr ? 'radarr' as const : 'sonarr' as const,
      lookup: () =>
        Promise.resolve({
          id: 42,
          title: 'Dark Angel',
          path: '/tv/Dark Angel',
          seasons: [],
        }),
      mediaFiles: () => Promise.resolve([]),
      extraFiles: () => Promise.resolve([]),
      torrentAssociations: () =>
        options.historyFailure ? Promise.reject(new Error('history failed')) : Promise.resolve([{
          hash,
          sourcePath,
          payloadPath: null,
          importedPath: '/tv/Dark Angel/episode-1.mkv',
          historyId: 1,
          date: null,
        }]),
      sonarrSeriesSnapshot: () => Promise.resolve({ episodes: [], files: [] }),
      downloadIdIsExclusiveTo: () =>
        options.exclusivityFailure
          ? Promise.reject(new Error('exclusivity lookup failed'))
          : Promise.resolve(options.shared !== true),
    },
  } as unknown as Parameters<typeof resolveDownloadCleanup>[2][number];
  const job = {
    id: hash,
    name: 'Dark Angel season pack',
    state: 'uploading',
    size: 200,
    uploaded: 0,
    completedAt: null,
    ratio: 1,
    seedingTime: 10,
    contentPath: '/downloads/release',
    savePath: '/downloads',
    trackerHost: null,
    fileCount: manifestFiles.length,
    files: manifestFiles,
    filesTruncated: false,
    manifestFiles,
  };
  const download = {
    provider: 'qbittorrent',
    instanceKey: 'db:1',
    configurationIdentity: 'db:1:10:http://qbit',
    instanceId: 1,
    instanceName: 'qBittorrent',
    client: {
      findJob: () => Promise.resolve(job),
      deleteJob: () => Promise.resolve(),
    },
  } as Parameters<typeof resolveDownloadCleanup>[3][number];
  return { arr, download, job };
}

Deno.test('default manifest-path authority still rejects partial Sonarr history coverage', async () => {
  const { arr, download } = partialShowTargets();
  const result = await resolveDownloadCleanup(
    'show-1',
    { title: 'Dark Angel', type: 'show', tmdbId: null, tvdbId: 76148 },
    [arr],
    [download],
  );
  assertEquals(result.downloadJobs, []);
  assertStringIncludes(result.reason ?? '', 'not all attributable');
});

Deno.test('whole-show hash authority fails closed on shared, failed, unowned, or malformed evidence', async () => {
  for (
    const options of [
      { shared: true },
      { historyFailure: true },
      { exclusivityFailure: true },
      { ownsSource: false },
      { radarr: true },
    ]
  ) {
    const { arr, download } = partialShowTargets(options);
    const result = await resolveDownloadCleanup(
      'show-1',
      { title: 'Dark Angel', type: 'show', tmdbId: null, tvdbId: 76148 },
      [arr],
      [download],
      new Set(),
      [],
      new Set(),
      undefined,
      { allowWholeShowHash: true },
    );
    assertEquals(result.downloadJobs, [], JSON.stringify(options));
  }
  const malformed = partialShowTargets({
    manifestFiles: [{ path: 'release/episode-1.mkv', size: null }],
  });
  const result = await resolveDownloadCleanup(
    'show-1',
    { title: 'Dark Angel', type: 'show', tmdbId: null, tvdbId: 76148 },
    [malformed.arr],
    [malformed.download],
    new Set(),
    [],
    new Set(),
    undefined,
    { allowWholeShowHash: true },
  );
  assertEquals(result.status, 'error');
  assertEquals(result.downloadJobs, []);
  assertStringIncludes(result.reason ?? '', 'malformed whole-show download evidence');
});

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
    seasons: null,
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
  assertStringIncludes(result.reason ?? '', 'current payload ownership could not be verified');
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
      instanceType: 'radarr',
      instanceUrl: 'http://radarr',
      configurationUpdatedAt: 1,
      mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
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

Deno.test('bounded Sonarr inventory failures remain item-scoped cleanup errors', async () => {
  const client = new ArrClient(
    'sonarr',
    'http://sonarr',
    'key',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/series?tvdbId=')) {
        return Promise.resolve(Response.json([{
          id: 7,
          title: 'Show',
          path: '/tv/Show',
          seasons: [],
        }]));
      }
      return Promise.resolve(new Response('Inventory unavailable', { status: 503 }));
    }) as typeof fetch,
  );
  const result = await resolveDownloadCleanup(
    'plex-show',
    { title: 'Show', type: 'show', tmdbId: null, tvdbId: 10 },
    [{
      instanceId: 1,
      instanceName: 'Sonarr',
      instanceType: 'sonarr',
      instanceUrl: 'http://sonarr',
      configurationUpdatedAt: 1,
      mappingIdentity: '{"addImportExclusion":false,"pathMappings":[]}',
      client,
      addImportExclusion: false,
      pathMappings: [],
    }],
    [],
  );

  assertEquals(result.status, 'error');
  assertEquals(result.arrStatus, 'resolved');
  assertEquals(result.arrTargets[0]?.mediaFiles, null);
  assertStringIncludes(result.reason ?? '', 'Inventory unavailable');
});
