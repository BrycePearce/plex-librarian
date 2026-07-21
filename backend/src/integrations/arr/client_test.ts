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
        { relativePath: 'Movie.mov', size: 2000 },
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
