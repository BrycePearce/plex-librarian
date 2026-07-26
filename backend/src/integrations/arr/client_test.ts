import { assertEquals, assertRejects } from '@std/assert';
import { ArrApiError, ArrClient, normalizeArrUrl } from './client.ts';

Deno.test('normalizeArrUrl preserves a base path and removes api/v3', () => {
  assertEquals(
    normalizeArrUrl('https://media.example/sonarr/api/v3/'),
    'https://media.example/sonarr',
  );
});

Deno.test('ArrClient looks up and deletes a Radarr movie by native id', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const mockFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/movie?tmdbId=550')) {
      return Promise.resolve(Response.json([{ id: 42, title: 'Fight Club' }]));
    }
    return Promise.resolve(Response.json({}, { status: 200 }));
  }) as typeof fetch;
  const client = new ArrClient('radarr', 'http://radarr:7878', 'secret', mockFetch);

  assertEquals(await client.lookup(550), {
    id: 42,
    title: 'Fight Club',
    path: null,
    seasons: null,
  });
  await client.deleteMedia(42, true);

  assertEquals(requests, [
    { url: 'http://radarr:7878/api/v3/movie?tmdbId=550', method: 'GET' },
    {
      url: 'http://radarr:7878/api/v3/movie/42?deleteFiles=true&addImportExclusion=true',
      method: 'DELETE',
    },
  ]);
});

Deno.test('ArrClient rejects an ambiguous external-id lookup', async () => {
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(Response.json([
        { id: 42, title: 'First' },
        { id: 43, title: 'Second' },
      ]))) as typeof fetch,
  );

  await assertRejects(
    () => client.lookup(550),
    ArrApiError,
    'multiple records',
  );
});

Deno.test('ArrClient rejects a falsy record in a non-empty lookup response', async () => {
  for (const response of [[null], [false], [0]]) {
    const client = new ArrClient(
      'radarr',
      'http://radarr:7878',
      'secret',
      (() => Promise.resolve(Response.json(response))) as typeof fetch,
    );

    await assertRejects(
      () => client.lookup(550),
      ArrApiError,
      'invalid managed record',
    );
  }
});

Deno.test('ArrClient rejects multiple managed Radarr movie files', async () => {
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(Response.json([
        { id: 1, relativePath: 'first.mkv', path: '/movies/Movie/first.mkv' },
        { id: 2, relativePath: 'second.mkv', path: '/movies/Movie/second.mkv' },
      ]))) as typeof fetch,
  );

  await assertRejects(
    () => client.radarrManagedFile(42),
    ArrApiError,
    'multiple managed files',
  );
});

Deno.test('ArrClient rejects malformed or partially valid Radarr managed-file responses', async () => {
  for (
    const response of [
      [null],
      [false],
      [0],
      [{ relativePath: 'missing-id.mkv', path: '/movies/Movie/missing-id.mkv' }],
      [
        { id: 1, relativePath: 'valid.mkv', path: '/movies/Movie/valid.mkv' },
        { relativePath: 'missing-id.mkv', path: '/movies/Movie/missing-id.mkv' },
      ],
    ]
  ) {
    const client = new ArrClient(
      'radarr',
      'http://radarr:7878',
      'secret',
      (() => Promise.resolve(Response.json(response))) as typeof fetch,
    );
    await assertRejects(() => client.radarrManagedFile(42), ArrApiError);
  }
});

Deno.test('ArrClient updates only the path on the complete existing Radarr movie record', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    ((input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Promise.resolve(Response.json({
        id: 42,
        title: 'Movie',
        path: '/movies/Movie',
        monitored: true,
        qualityProfileId: 7,
        tags: [3],
      }));
    }) as typeof fetch,
  );

  assertEquals(
    await client.updateMoviePath(42, '/movies/Movie', '/movies-4k/Movie'),
    true,
  );
  assertEquals(requests, [
    {
      url: 'http://radarr:7878/api/v3/movie/42',
      method: 'GET',
      body: null,
    },
    {
      url: 'http://radarr:7878/api/v3/movie/42?moveFiles=false',
      method: 'PUT',
      body: {
        id: 42,
        title: 'Movie',
        path: '/movies-4k/Movie',
        monitored: true,
        qualityProfileId: 7,
        tags: [3],
      },
    },
  ]);
});

Deno.test('ArrClient reconciles an already-updated Radarr path without another mutation', async () => {
  let requests = 0;
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() => {
      requests++;
      return Promise.resolve(Response.json({
        id: 42,
        title: 'Movie',
        path: '/movies-4k/Movie',
      }));
    }) as typeof fetch,
  );

  assertEquals(
    await client.updateMoviePath(42, '/movies/Movie', '/movies-4k/Movie'),
    false,
  );
  assertEquals(requests, 1);
});

Deno.test('ArrClient rejects a Radarr path changed to an unexpected third location', async () => {
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(Response.json({
        id: 42,
        title: 'Movie',
        path: '/unexpected/Movie',
      }))) as typeof fetch,
  );

  await assertRejects(
    () => client.updateMoviePath(42, '/movies/Movie', '/movies-4k/Movie'),
    ArrApiError,
    'changed the movie path',
  );
});

Deno.test('ArrClient identifies a Sonarr file shared by multiple episodes', async () => {
  const client = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/episode?seriesId=8')) {
        return Promise.resolve(Response.json([
          { id: 9, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 },
          { id: 11, seasonNumber: 1, episodeNumber: 2, episodeFileId: 10 },
        ]));
      }
      return Promise.resolve(Response.json({
        id: 10,
        relativePath: 'Season 01/shared.mkv',
        path: '/tv/Show/Season 01/shared.mkv',
        size: 100,
      }));
    }) as typeof fetch,
  );

  assertEquals(await client.episodeManagedFile(8, 1, 1), {
    episodeId: 9,
    shared: true,
    file: {
      id: 10,
      relativePath: 'Season 01/shared.mkv',
      path: '/tv/Show/Season 01/shared.mkv',
      size: 100,
    },
  });
});

Deno.test('ArrClient rejects a malformed referenced Sonarr episode file', async () => {
  const client = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    ((input: string | URL | Request) =>
      String(input).includes('/episode?seriesId=8')
        ? Promise.resolve(Response.json([
          { id: 9, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 },
        ]))
        : Promise.resolve(Response.json({
          relativePath: 'Season 01/episode.mkv',
          path: '/tv/Show/Season 01/episode.mkv',
        }))) as typeof fetch,
  );

  await assertRejects(
    () => client.episodeManagedFile(8, 1, 1),
    ArrApiError,
    'invalid managed episode file',
  );
});

Deno.test('ArrClient uses Sonarr TVDB lookup and list exclusion parameter', async () => {
  const urls: string[] = [];
  const mockFetch = ((input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(
      String(input).includes('/series?')
        ? Response.json([{ id: 7, title: 'Example' }])
        : Response.json({}),
    );
  }) as typeof fetch;
  const client = new ArrClient('sonarr', 'http://sonarr:8989', 'secret', mockFetch);
  await client.lookup(123);
  await client.deleteMedia(7, false);
  assertEquals(urls, [
    'http://sonarr:8989/api/v3/series?tvdbId=123',
    'http://sonarr:8989/api/v3/series/7?deleteFiles=true&addImportListExclusion=false',
  ]);
});

Deno.test('ArrClient unmonitors a Radarr movie without deleting its record or files', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const mockFetch = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Promise.resolve(Response.json({ id: 42, title: 'Movie', monitored: true }));
  }) as typeof fetch;
  const client = new ArrClient('radarr', 'http://radarr:7878', 'secret', mockFetch);

  assertEquals(await client.monitorTarget(42), { id: 42, monitored: true });
  assertEquals(await client.setMonitorTarget(42, false), true);
  assertEquals(requests, [
    { url: 'http://radarr:7878/api/v3/movie/42', method: 'GET', body: null },
    { url: 'http://radarr:7878/api/v3/movie/42', method: 'GET', body: null },
    {
      url: 'http://radarr:7878/api/v3/movie/42',
      method: 'PUT',
      body: { id: 42, title: 'Movie', monitored: false },
    },
  ]);
});

Deno.test('ArrClient resolves and unmonitors one Sonarr episode', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const mockFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/episode?')) {
      return Promise.resolve(Response.json([
        { id: 70, seasonNumber: 1, episodeNumber: 1, monitored: true },
        { id: 71, seasonNumber: 1, episodeNumber: 2, monitored: true },
      ]));
    }
    return Promise.resolve(Response.json({
      id: 71,
      seriesId: 7,
      seasonNumber: 1,
      episodeNumber: 2,
      monitored: true,
    }));
  }) as typeof fetch;
  const client = new ArrClient('sonarr', 'http://sonarr:8989', 'secret', mockFetch);

  assertEquals(
    await client.monitorTarget(7, { seasonNumber: 1, episodeNumber: 2 }),
    { id: 71, monitored: true },
  );
  assertEquals(await client.setMonitorTarget(71, false), true);
  assertEquals(requests, [
    {
      url: 'http://sonarr:8989/api/v3/episode?seriesId=7&seasonNumber=1',
      method: 'GET',
    },
    { url: 'http://sonarr:8989/api/v3/episode/71', method: 'GET' },
    { url: 'http://sonarr:8989/api/v3/episode/71', method: 'PUT' },
  ]);
});

Deno.test('Sonarr lookup exposes bounded season summaries with managed files', async () => {
  const client = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    (() =>
      Promise.resolve(Response.json([{
        id: 7,
        title: 'Example',
        path: '/tv/Example',
        seasons: [
          { seasonNumber: 2, statistics: { episodeFileCount: 8, sizeOnDisk: 8000 } },
          { seasonNumber: 0, statistics: { episodeFileCount: 1, sizeOnDisk: 1000 } },
          { seasonNumber: 3, statistics: { episodeFileCount: 0, sizeOnDisk: 0 } },
          { seasonNumber: 1, statistics: { episodeFileCount: 10, sizeOnDisk: 10000 } },
        ],
      }]))) as typeof fetch,
  );

  assertEquals(await client.lookup(123), {
    id: 7,
    title: 'Example',
    path: '/tv/Example',
    seasons: [
      { seasonNumber: 0, episodeFileCount: 1, size: 1000 },
      { seasonNumber: 1, episodeFileCount: 10, size: 10000 },
      { seasonNumber: 2, episodeFileCount: 8, size: 8000 },
    ],
  });
});

Deno.test('torrentAssociations keeps only imported BitTorrent download IDs', async () => {
  const mockFetch = (() =>
    Promise.resolve(Response.json([
      {
        eventType: 'downloadFolderImported',
        downloadId: 'A'.repeat(40),
        id: 9,
        date: '2026-01-01T00:00:00Z',
        data: {
          droppedPath: '/downloads/release/movie.mkv',
          sourcePath: '/downloads/release',
          importedPath: '/movies/Movie/movie.mkv',
        },
      },
      { eventType: 'grabbed', downloadId: 'B'.repeat(40) },
      { eventType: 'downloadFolderImported', downloadId: 'usenet-id' },
    ]))) as typeof fetch;
  const client = new ArrClient('radarr', 'http://radarr:7878', 'secret', mockFetch);
  assertEquals(await client.torrentAssociations(42), [{
    hash: 'a'.repeat(40),
    sourcePath: '/downloads/release/movie.mkv',
    payloadPath: '/downloads/release',
    importedPath: '/movies/Movie/movie.mkv',
    historyId: 9,
    date: '2026-01-01T00:00:00Z',
  }]);
});

Deno.test('download history detects a hash associated with another Arr title', async () => {
  const exclusive = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(Response.json({
        totalRecords: 2,
        records: [{ movieId: 42 }, { movieId: 42 }],
      }))) as typeof fetch,
  );
  assertEquals(await exclusive.downloadIdIsExclusiveTo(42, 'a'.repeat(40)), true);

  const shared = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    (() =>
      Promise.resolve(Response.json({
        totalRecords: 2,
        records: [{ seriesId: 7 }, { seriesId: 9 }],
      }))) as typeof fetch,
  );
  assertEquals(await shared.downloadIdIsExclusiveTo(7, 'a'.repeat(40)), false);
});

Deno.test('Radarr lookup and extra files expose its managed deletion boundary', async () => {
  const mockFetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/movie?tmdbId=')) {
      return Promise.resolve(Response.json([{
        id: 42,
        title: 'Movie',
        path: 'A:\\Movies\\Movie',
      }]));
    }
    if (url.includes('/moviefile?movieId=')) {
      return Promise.resolve(Response.json([
        { id: 99, relativePath: 'Movie.mov', path: 'A:\\Movies\\Movie\\Movie.mov', size: 2000 },
      ]));
    }
    return Promise.resolve(Response.json([
      { relativePath: 'Movie.idx', type: 'subtitle' },
      { relativePath: 'Movie.sub', type: 0 },
      { relativePath: 'movie.nfo', type: 1 },
      { relativePath: 'extras/trailer.mov', type: 2 },
    ]));
  }) as typeof fetch;
  const client = new ArrClient('radarr', 'http://radarr:7878', 'secret', mockFetch);
  assertEquals(await client.lookup(550), {
    id: 42,
    title: 'Movie',
    path: 'A:\\Movies\\Movie',
    seasons: null,
  });
  assertEquals(await client.mediaFiles(42), [
    { relativePath: 'Movie.mov', size: 2000 },
  ]);
  assertEquals(await client.radarrManagedFile(42), {
    id: 99,
    relativePath: 'Movie.mov',
    path: 'A:\\Movies\\Movie\\Movie.mov',
    size: 2000,
  });
  assertEquals(await client.extraFiles(42), [
    { relativePath: 'Movie.idx', type: 'subtitle' },
    { relativePath: 'Movie.sub', type: 'subtitle' },
    { relativePath: 'movie.nfo', type: 'metadata' },
    { relativePath: 'extras/trailer.mov', type: 'other' },
  ]);
});

Deno.test('Sonarr deletion preview stays at the managed series root', async () => {
  let requested = false;
  const client = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    (() => {
      requested = true;
      return Promise.resolve(Response.json([]));
    }) as typeof fetch,
  );
  assertEquals(await client.mediaFiles(7), null);
  assertEquals(requested, false);
});

Deno.test('ArrClient surfaces an HTTP failure', async () => {
  const mockFetch =
    (() => Promise.resolve(new Response('Unauthorized', { status: 401 }))) as typeof fetch;
  const client = new ArrClient('radarr', 'http://radarr:7878', 'bad-key', mockFetch);
  await assertRejects(() => client.testConnection(), ArrApiError, 'Radarr returned 401');
});

Deno.test('ArrClient rejects the wrong Arr application type', async () => {
  const mockFetch = (() => Promise.resolve(Response.json({ appName: 'Sonarr' }))) as typeof fetch;
  const client = new ArrClient('radarr', 'http://sonarr:8989', 'key', mockFetch);
  await assertRejects(() => client.testConnection(), ArrApiError, 'Expected Radarr');
});
