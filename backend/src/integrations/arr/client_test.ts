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

  assertEquals(await client.lookup(550), { id: 42, title: 'Fight Club', path: null });
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

Deno.test('torrentAssociations keeps only imported BitTorrent download IDs', async () => {
  const mockFetch = (() =>
    Promise.resolve(Response.json([
      {
        eventType: 'downloadFolderImported',
        downloadId: 'A'.repeat(40),
        data: { droppedPath: '/downloads/release/movie.mkv' },
      },
      { eventType: 'grabbed', downloadId: 'B'.repeat(40) },
      { eventType: 'downloadFolderImported', downloadId: 'usenet-id' },
    ]))) as typeof fetch;
  const client = new ArrClient('radarr', 'http://radarr:7878', 'secret', mockFetch);
  assertEquals(await client.torrentAssociations(42), [{
    hash: 'a'.repeat(40),
    sourcePath: '/downloads/release/movie.mkv',
  }]);
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
