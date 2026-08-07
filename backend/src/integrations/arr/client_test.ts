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

Deno.test('ArrClient reads one targeted Radarr movie and exact file visibility', async () => {
  const requests: string[] = [];
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    ((input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/api/v3/movie/42') {
        return Promise.resolve(Response.json({ id: 42, path: '/movies/Movie' }));
      }
      return Promise.resolve(Response.json({ type: 'file' }));
    }) as typeof fetch,
  );

  assertEquals(await client.radarrMovie(42), { id: 42, path: '/movies/Movie' });
  assertEquals(await client.fileVisibility('/movies/Movie/kept.mkv'), 'file');
  assertEquals(requests, [
    '/api/v3/movie/42',
    '/api/v3/filesystem/type?path=%2Fmovies%2FMovie%2Fkept.mkv',
  ]);
});

Deno.test('ArrClient rejects malformed Radarr file visibility and extra ownership', async () => {
  const visibility = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() => Promise.resolve(Response.json({ type: 'missing' }))) as typeof fetch,
  );
  await assertRejects(() => visibility.fileVisibility('/movies/Movie/kept.mkv'), ArrApiError);

  const extras = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(Response.json([{
        relativePath: 'movie.nfo',
        type: 'metadata',
        movieFileId: -1,
      }]))) as typeof fetch,
  );
  await assertRejects(() => extras.extraFiles(42), ArrApiError, 'ownership');

  const missingOwnership = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(Response.json([{
        relativePath: 'movie.nfo',
        type: 'metadata',
      }]))) as typeof fetch,
  );
  await assertRejects(() => missingOwnership.extraFiles(42), ArrApiError, 'ownership');

  const malformedExtra = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(Response.json([{
        type: 'metadata',
        movieFileId: 99,
      }]))) as typeof fetch,
  );
  await assertRejects(() => malformedExtra.extraFiles(42), ArrApiError, 'extra-file record');
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

Deno.test('ArrClient preserves a complete Radarr movie resource and verifies monitoring', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  let monitored = true;
  const mockFetch = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (init?.method === 'PUT') monitored = false;
    return Promise.resolve(Response.json({
      id: 42,
      tmdbId: 123,
      title: 'Movie',
      path: '/movies/Movie',
      monitored,
      qualityProfileId: 7,
      tags: [3],
    }));
  }) as typeof fetch;
  const client = new ArrClient('radarr', 'http://radarr:7878', 'secret', mockFetch);
  const identity = { movieId: 42, tmdbId: 123, path: '/movies/Movie' };

  assertEquals(await client.radarrMovieMonitorTarget(identity), { id: 42, monitored: true });
  assertEquals(await client.setRadarrMovieMonitored(identity, false), true);
  assertEquals(requests, [
    { url: 'http://radarr:7878/api/v3/movie/42', method: 'GET', body: null },
    { url: 'http://radarr:7878/api/v3/movie/42', method: 'GET', body: null },
    {
      url: 'http://radarr:7878/api/v3/movie/42',
      method: 'PUT',
      body: {
        id: 42,
        tmdbId: 123,
        title: 'Movie',
        path: '/movies/Movie',
        monitored: false,
        qualityProfileId: 7,
        tags: [3],
      },
    },
    { url: 'http://radarr:7878/api/v3/movie/42', method: 'GET', body: null },
  ]);
});

Deno.test('ArrClient updates only an exact Sonarr episode and verifies monitoring', async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  let monitored = true;
  const mockFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (init?.method === 'PUT') monitored = false;
    return Promise.resolve(Response.json({
      id: 71,
      seriesId: 7,
      seasonNumber: 1,
      episodeNumber: 2,
      monitored,
    }));
  }) as typeof fetch;
  const client = new ArrClient('sonarr', 'http://sonarr:8989', 'secret', mockFetch);
  const identity = { episodeId: 71, seriesId: 7, seasonNumber: 1, episodeNumber: 2 };

  assertEquals(
    await client.sonarrEpisodeMonitorTarget(identity),
    { id: 71, monitored: true },
  );
  assertEquals(await client.setSonarrEpisodeMonitored(identity, false), true);
  assertEquals(requests, [
    {
      url: 'http://sonarr:8989/api/v3/episode/71',
      method: 'GET',
      body: null,
    },
    { url: 'http://sonarr:8989/api/v3/episode/71', method: 'GET', body: null },
    {
      url: 'http://sonarr:8989/api/v3/episode/71',
      method: 'PUT',
      body: { id: 71, monitored: false },
    },
    { url: 'http://sonarr:8989/api/v3/episode/71', method: 'GET', body: null },
  ]);
});

Deno.test('ArrClient rejects malformed exact monitoring identities and states', async () => {
  const sonarr = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    (() =>
      Promise.resolve(Response.json({
        id: 71,
        seriesId: 8,
        seasonNumber: 1,
        episodeNumber: 2,
      }))) as typeof fetch,
  );
  await assertRejects(
    () =>
      sonarr.sonarrEpisodeMonitorTarget({
        episodeId: 71,
        seriesId: 7,
        seasonNumber: 1,
        episodeNumber: 2,
      }),
    ArrApiError,
    'conflicting or malformed',
  );

  const radarr = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(Response.json({
        id: 42,
        tmdbId: 999,
        path: '/movies/Movie',
        monitored: false,
      }))) as typeof fetch,
  );
  await assertRejects(
    () =>
      radarr.radarrMovieMonitorTarget({
        movieId: 42,
        tmdbId: 123,
        path: '/movies/Movie',
      }),
    ArrApiError,
    'conflicting or malformed',
  );

  let invalidIdentityRequests = 0;
  const invalidSonarr = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    (() => {
      invalidIdentityRequests++;
      return Promise.resolve(Response.json({}));
    }) as typeof fetch,
  );
  await assertRejects(
    () =>
      invalidSonarr.sonarrEpisodeMonitorTarget({
        episodeId: 0,
        seriesId: 7,
        seasonNumber: 1,
        episodeNumber: 2,
      }),
    ArrApiError,
    'identity is invalid',
  );

  const invalidRadarr = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() => {
      invalidIdentityRequests++;
      return Promise.resolve(Response.json({}));
    }) as typeof fetch,
  );
  await assertRejects(
    () =>
      invalidRadarr.radarrMovieMonitorTarget({
        movieId: 42,
        tmdbId: 0,
        path: '/movies/Movie',
      }),
    ArrApiError,
    'identity is invalid',
  );
  assertEquals(invalidIdentityRequests, 0);
});

Deno.test('ArrClient monitoring writes reconcile errors through exact read-back', async () => {
  for (const failure of ['http', 'transport'] as const) {
    let monitored = true;
    let puts = 0;
    const client = new ArrClient(
      'sonarr',
      'http://sonarr:8989',
      'secret',
      ((_: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          puts++;
          monitored = false;
          return failure === 'http'
            ? Promise.resolve(new Response('rejected', { status: 500 }))
            : Promise.reject(new TypeError('lost response'));
        }
        return Promise.resolve(Response.json({
          id: 71,
          seriesId: 7,
          seasonNumber: 1,
          episodeNumber: 2,
          monitored,
        }));
      }) as typeof fetch,
    );
    const identity = { episodeId: 71, seriesId: 7, seasonNumber: 1, episodeNumber: 2 };
    assertEquals(await client.setSonarrEpisodeMonitored(identity, false), true);
    assertEquals(await client.setSonarrEpisodeMonitored(identity, false), false);
    assertEquals(puts, 1);
  }
});

Deno.test('ArrClient preserves a definite monitoring PUT error when read-back disproves it', async () => {
  const client = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    ((_: string | URL | Request, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Promise.resolve(new Response('forbidden', { status: 403 }))
        : Promise.resolve(Response.json({
          id: 71,
          seriesId: 7,
          seasonNumber: 1,
          episodeNumber: 2,
          monitored: true,
        }))) as typeof fetch,
  );
  await assertRejects(
    () =>
      client.setSonarrEpisodeMonitored(
        { episodeId: 71, seriesId: 7, seasonNumber: 1, episodeNumber: 2 },
        false,
      ),
    ArrApiError,
    'returned 403',
  );
});

Deno.test('Radarr monitoring writes reconcile HTTP and transport errors through read-back', async () => {
  for (const failure of ['http', 'transport'] as const) {
    let monitored = true;
    let puts = 0;
    const client = new ArrClient(
      'radarr',
      'http://radarr:7878',
      'secret',
      ((_: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          puts++;
          monitored = false;
          return failure === 'http'
            ? Promise.resolve(new Response('rejected', { status: 500 }))
            : Promise.reject(new TypeError('lost response'));
        }
        return Promise.resolve(Response.json({
          id: 42,
          tmdbId: 123,
          path: '/movies/Movie',
          monitored,
          qualityProfileId: 7,
        }));
      }) as typeof fetch,
    );
    const identity = { movieId: 42, tmdbId: 123, path: '/movies/Movie' };
    assertEquals(await client.setRadarrMovieMonitored(identity, false), true);
    assertEquals(await client.setRadarrMovieMonitored(identity, false), false);
    assertEquals(puts, 1);
  }
});

Deno.test('ArrClient treats failed monitoring read-back as inconclusive', async () => {
  for (const type of ['sonarr', 'radarr'] as const) {
    let reads = 0;
    const client = new ArrClient(
      type,
      `http://${type}`,
      'secret',
      ((_: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return Promise.resolve(new Response('rejected', { status: 503 }));
        }
        reads++;
        if (reads > 1) return Promise.reject(new TypeError('read-back unavailable'));
        return Promise.resolve(Response.json(
          type === 'sonarr'
            ? {
              id: 71,
              seriesId: 7,
              seasonNumber: 1,
              episodeNumber: 2,
              monitored: true,
            }
            : {
              id: 42,
              tmdbId: 123,
              path: '/movies/Movie',
              monitored: true,
              qualityProfileId: 7,
            },
        ));
      }) as typeof fetch,
    );
    const error = await assertRejects(
      () =>
        type === 'sonarr'
          ? client.setSonarrEpisodeMonitored(
            { episodeId: 71, seriesId: 7, seasonNumber: 1, episodeNumber: 2 },
            false,
          )
          : client.setRadarrMovieMonitored(
            { movieId: 42, tmdbId: 123, path: '/movies/Movie' },
            false,
          ),
      ArrApiError,
      'read-back was inconclusive',
    );
    assertEquals((error as ArrApiError).retryable, true);
    assertEquals((error as ArrApiError).status, undefined);
  }
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
      { relativePath: 'Movie.idx', type: 'subtitle', movieFileId: null },
      { relativePath: 'Movie.sub', type: 0, movieFileId: null },
      { relativePath: 'movie.nfo', type: 1, movieFileId: null },
      { relativePath: 'extras/trailer.mov', type: 2, movieFileId: null },
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
    { relativePath: 'Movie.idx', type: 'subtitle', movieFileId: null },
    { relativePath: 'Movie.sub', type: 'subtitle', movieFileId: null },
    { relativePath: 'movie.nfo', type: 'metadata', movieFileId: null },
    { relativePath: 'extras/trailer.mov', type: 'other', movieFileId: null },
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
