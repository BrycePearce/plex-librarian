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
    tmdbId: null,
    year: null,
    monitored: null,
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
      Promise.resolve(
        Response.json([
          { id: 42, title: 'First' },
          { id: 43, title: 'Second' },
        ]),
      )) as typeof fetch,
  );

  await assertRejects(() => client.lookup(550), ArrApiError, 'multiple records');
});

Deno.test('ArrClient rejects a falsy record in a non-empty lookup response', async () => {
  for (const response of [[null], [false], [0]]) {
    const client = new ArrClient(
      'radarr',
      'http://radarr:7878',
      'secret',
      (() => Promise.resolve(Response.json(response))) as typeof fetch,
    );

    await assertRejects(() => client.lookup(550), ArrApiError, 'invalid managed record');
  }
});

Deno.test('ArrClient rejects multiple managed Radarr movie files', async () => {
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(
        Response.json([
          { id: 1, relativePath: 'first.mkv', path: '/movies/Movie/first.mkv' },
          { id: 2, relativePath: 'second.mkv', path: '/movies/Movie/second.mkv' },
        ]),
      )) as typeof fetch,
  );

  await assertRejects(() => client.radarrManagedFile(42), ArrApiError, 'multiple managed files');
});

Deno.test(
  'ArrClient rejects malformed or partially valid Radarr managed-file responses',
  async () => {
    for (
      const response of [
        [null],
        [false],
        [0],
        [
          {
            relativePath: 'missing-id.mkv',
            path: '/movies/Movie/missing-id.mkv',
          },
        ],
        [
          { id: 1, relativePath: 'valid.mkv', path: '/movies/Movie/valid.mkv' },
          {
            relativePath: 'missing-id.mkv',
            path: '/movies/Movie/missing-id.mkv',
          },
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
  },
);

Deno.test('ArrClient reads one targeted Radarr movie and exact file visibility', async () => {
  const requests: string[] = [];
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    ((
      input: string | URL | Request,
    ) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/api/v3/movie/42') {
        return Promise.resolve(Response.json({ id: 42, path: '/movies/Movie' }));
      }
      return Promise.resolve(Response.json({ type: 'file' }));
    }) as typeof fetch,
  );

  assertEquals(await client.radarrMovie(42), {
    id: 42,
    path: '/movies/Movie',
  });
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
      Promise.resolve(
        Response.json([
          {
            relativePath: 'movie.nfo',
            type: 'metadata',
            movieFileId: -1,
          },
        ]),
      )) as typeof fetch,
  );
  await assertRejects(() => extras.extraFiles(42), ArrApiError, 'ownership');

  const missingOwnership = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(
        Response.json([
          {
            relativePath: 'movie.nfo',
            type: 'metadata',
          },
        ]),
      )) as typeof fetch,
  );
  await assertRejects(() => missingOwnership.extraFiles(42), ArrApiError, 'ownership');

  const malformedExtra = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(
        Response.json([
          {
            type: 'metadata',
            movieFileId: 99,
          },
        ]),
      )) as typeof fetch,
  );
  await assertRejects(() => malformedExtra.extraFiles(42), ArrApiError, 'extra-file record');
});

Deno.test('Radarr retained-path capability is feature-gated at 6.3.0.10514', async () => {
  for (
    const [version, available] of [
      ['6.3.0.10513', false],
      ['6.3.0.10514', true],
      ['6.4.0.1', true],
    ] as const
  ) {
    const client = new ArrClient(
      'radarr',
      'http://radarr:7878',
      'secret',
      ((
        input: string | URL | Request,
      ) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/system/status')) return Promise.resolve(Response.json({ version }));
        if (path.endsWith('/config/mediamanagement')) {
          return Promise.resolve(
            Response.json({
              autoUnmonitorPreviouslyDownloadedMovies: true,
              deleteEmptyFolders: true,
              fileDate: 'none',
              rescanAfterRefresh: 'always',
            }),
          );
        }
        return Promise.resolve(Response.json([]));
      }) as typeof fetch,
    );
    const capabilities = await client.radarrPathAdoptionCapabilities();
    assertEquals(capabilities.available, available);
    assertEquals(capabilities.minimumVersion, '6.3.0.10514');
  }

  for (const version of ['development', '6.3.0', '6.3.0.10514-preview', '6.3.0.10514.1']) {
    const unverifiable = new ArrClient(
      'radarr',
      'http://radarr:7878',
      'secret',
      (() => Promise.resolve(Response.json({ version }))) as typeof fetch,
    );
    assertEquals((await unverifiable.radarrPathAdoptionCapabilities()).available, false);
  }
});

Deno.test('Radarr path update preserves the fresh resource and always disables moves', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let path = '/movies/Old';
  let monitored = true;
  const resource = () => ({
    id: 42,
    tmdbId: 550,
    title: 'Movie',
    path,
    monitored,
    qualityProfileId: 7,
    rootFolderPath: '/movies/',
  });
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ url: String(input), init });
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        assertEquals(body.qualityProfileId, 7);
        path = body.path;
        monitored = body.monitored;
      }
      return Promise.resolve(Response.json(resource()));
    }) as typeof fetch,
  );
  const result = await client.updateRadarrMoviePath(
    { movieId: 42, tmdbId: 550, path: '/movies/Old' },
    '/movies/Kept',
  );
  assertEquals(result.changed, true);
  const put = requests.find((request) => request.init?.method === 'PUT')!;
  assertEquals(new URL(put.url).searchParams.get('moveFiles'), 'false');
  assertEquals(result.after.path, '/movies/Kept');
  assertEquals(result.after.monitored, false);
});

Deno.test('Radarr movie updates allow only documented computed changes', async () => {
  for (const unrelatedDrift of [false, true]) {
    let path = '/movies/Old';
    let monitored = true;
    let afterPut = false;
    const resource = () => ({
      id: 42,
      tmdbId: 550,
      title: unrelatedDrift && afterPut ? 'Externally edited' : 'Movie',
      path,
      monitored,
      qualityProfileId: 7,
      rootFolderPath: afterPut ? '/movies/NewRoot/' : '/movies/',
      tags: afterPut ? [2] : [1],
      statistics: { sizeOnDisk: afterPut ? 10 : 20 },
      movieFileId: afterPut ? 99 : 10,
    });
    const client = new ArrClient(
      'radarr',
      'http://radarr:7878',
      'secret',
      ((
        _: string | URL | Request,
        init?: RequestInit,
      ) => {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          path = body.path;
          monitored = body.monitored;
          afterPut = true;
        }
        return Promise.resolve(Response.json(resource()));
      }) as typeof fetch,
    );
    const update = () =>
      client.updateRadarrMoviePath(
        { movieId: 42, tmdbId: 550, path: '/movies/Old' },
        '/movies/New',
      );
    if (unrelatedDrift) {
      await assertRejects(update, ArrApiError, 'unrelated movie fields');
    } else {
      assertEquals((await update()).after.path, '/movies/New');
    }
  }
});

Deno.test('Radarr activity permits only the exact persisted rescan command', async () => {
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    ((
      input: string | URL | Request,
    ) => {
      const path = new URL(String(input)).pathname;
      return Promise.resolve(
        Response.json(
          path.endsWith('/queue')
            ? { records: [] }
            : [{ id: 77, movieId: 42, name: 'RescanMovie' }],
        ),
      );
    }) as typeof fetch,
  );
  assertEquals((await client.radarrMovieActivity(42)).quiet, false);
  assertEquals(await client.radarrMovieActivity(42, [77]), {
    quiet: true,
    blocking: [],
  });
});

Deno.test('Radarr activity attributes bulk movie commands to every targeted movie', async () => {
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    ((input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return Promise.resolve(
        Response.json(
          path.endsWith('/queue')
            ? { records: [] }
            : [{ id: 91, name: 'RenameMovie', body: { movieIds: [7, 42] } }],
        ),
      );
    }) as typeof fetch,
  );

  assertEquals(await client.radarrMovieActivity(42), {
    quiet: false,
    blocking: [{ source: 'command', id: 91, name: 'RenameMovie' }],
  });
});

Deno.test('Radarr immediate-child enumeration rejects incomplete entries', async () => {
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(
        Response.json([{ path: '/movies/Movie/file.mkv', type: 'file' }]),
      )) as typeof fetch,
  );
  await assertRejects(
    () => client.radarrImmediateChildren('/movies/Movie'),
    ArrApiError,
    'incomplete filesystem entry',
  );
});

Deno.test('Radarr immediate-child enumeration rejects non-child paths', async () => {
  const client = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(
        Response.json([{ path: '/movies/Other/file.mkv', name: 'file.mkv', type: 'file' }]),
      )) as typeof fetch,
  );
  await assertRejects(
    () => client.radarrImmediateChildren('/movies/Movie'),
    ArrApiError,
    'non-immediate',
  );
});

Deno.test('Radarr catalog and filesystem enumeration enforce record limits', async () => {
  const catalog = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(
        Response.json(
          Array.from({ length: 50_001 }, (_, index) => ({
            id: index + 1,
            tmdbId: index + 1,
            path: `/movies/${index + 1}`,
          })),
        ),
      )) as typeof fetch,
  );
  await assertRejects(
    () => catalog.radarrMovieCatalogPaths(),
    ArrApiError,
    '50000-record safety limit',
  );

  const filesystem = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(
        Response.json(
          Array.from({ length: 2_001 }, (_, index) => ({
            path: `/movies/Movie/${index}.nfo`,
            name: `${index}.nfo`,
            type: 'file',
          })),
        ),
      )) as typeof fetch,
  );
  await assertRejects(
    () => filesystem.radarrImmediateChildren('/movies/Movie'),
    ArrApiError,
    '2000-entry safety limit',
  );
});

Deno.test('ArrClient identifies a Sonarr file shared by multiple episodes', async () => {
  const client = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    ((
      input: string | URL | Request,
    ) => {
      const url = String(input);
      if (url.includes('/episode?seriesId=8')) {
        return Promise.resolve(
          Response.json([
            { id: 9, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 },
            { id: 11, seasonNumber: 1, episodeNumber: 2, episodeFileId: 10 },
          ]),
        );
      }
      return Promise.resolve(
        Response.json({
          id: 10,
          relativePath: 'Season 01/shared.mkv',
          path: '/tv/Show/Season 01/shared.mkv',
          size: 100,
        }),
      );
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
    ((
      input: string | URL | Request,
    ) =>
      String(input).includes('/episode?seriesId=8')
        ? Promise.resolve(
          Response.json([{ id: 9, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10 }]),
        )
        : Promise.resolve(
          Response.json({
            relativePath: 'Season 01/episode.mkv',
            path: '/tv/Show/Season 01/episode.mkv',
          }),
        )) as typeof fetch,
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

Deno.test(
  'ArrClient preserves a complete Radarr movie resource and verifies monitoring',
  async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    let monitored = true;
    const mockFetch = ((input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (init?.method === 'PUT') monitored = false;
      return Promise.resolve(
        Response.json({
          id: 42,
          tmdbId: 123,
          title: 'Movie',
          path: '/movies/Movie',
          monitored,
          qualityProfileId: 7,
          tags: [3],
        }),
      );
    }) as typeof fetch;
    const client = new ArrClient('radarr', 'http://radarr:7878', 'secret', mockFetch);
    const identity = { movieId: 42, tmdbId: 123, path: '/movies/Movie' };

    assertEquals(await client.radarrMovieMonitorTarget(identity), {
      id: 42,
      monitored: true,
    });
    assertEquals(await client.setRadarrMovieMonitored(identity, false), true);
    assertEquals(requests, [
      { url: 'http://radarr:7878/api/v3/movie/42', method: 'GET', body: null },
      { url: 'http://radarr:7878/api/v3/movie/42', method: 'GET', body: null },
      {
        url: 'http://radarr:7878/api/v3/movie/42?moveFiles=false',
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
  },
);

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
    return Promise.resolve(
      Response.json({
        id: 71,
        seriesId: 7,
        seasonNumber: 1,
        episodeNumber: 2,
        monitored,
      }),
    );
  }) as typeof fetch;
  const client = new ArrClient('sonarr', 'http://sonarr:8989', 'secret', mockFetch);
  const identity = {
    episodeId: 71,
    seriesId: 7,
    seasonNumber: 1,
    episodeNumber: 2,
  };

  assertEquals(await client.sonarrEpisodeMonitorTarget(identity), {
    id: 71,
    monitored: true,
  });
  assertEquals(await client.setSonarrEpisodeMonitored(identity, false), true);
  assertEquals(requests, [
    {
      url: 'http://sonarr:8989/api/v3/episode/71',
      method: 'GET',
      body: null,
    },
    {
      url: 'http://sonarr:8989/api/v3/episode/71',
      method: 'GET',
      body: null,
    },
    {
      url: 'http://sonarr:8989/api/v3/episode/71',
      method: 'PUT',
      body: { id: 71, monitored: false },
    },
    {
      url: 'http://sonarr:8989/api/v3/episode/71',
      method: 'GET',
      body: null,
    },
  ]);
});

Deno.test('ArrClient rejects malformed exact monitoring identities and states', async () => {
  const sonarr = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    (() =>
      Promise.resolve(
        Response.json({
          id: 71,
          seriesId: 8,
          seasonNumber: 1,
          episodeNumber: 2,
        }),
      )) as typeof fetch,
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
      Promise.resolve(
        Response.json({
          id: 42,
          tmdbId: 999,
          path: '/movies/Movie',
          monitored: false,
        }),
      )) as typeof fetch,
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
      ((
        _: string | URL | Request,
        init?: RequestInit,
      ) => {
        if (init?.method === 'PUT') {
          puts++;
          monitored = false;
          return failure === 'http'
            ? Promise.resolve(new Response('rejected', { status: 500 }))
            : Promise.reject(new TypeError('lost response'));
        }
        return Promise.resolve(
          Response.json({
            id: 71,
            seriesId: 7,
            seasonNumber: 1,
            episodeNumber: 2,
            monitored,
          }),
        );
      }) as typeof fetch,
    );
    const identity = {
      episodeId: 71,
      seriesId: 7,
      seasonNumber: 1,
      episodeNumber: 2,
    };
    assertEquals(await client.setSonarrEpisodeMonitored(identity, false), true);
    assertEquals(await client.setSonarrEpisodeMonitored(identity, false), false);
    assertEquals(puts, 1);
  }
});

Deno.test(
  'ArrClient preserves a definite monitoring PUT error when read-back disproves it',
  async () => {
    const client = new ArrClient(
      'sonarr',
      'http://sonarr:8989',
      'secret',
      ((
        _: string | URL | Request,
        init?: RequestInit,
      ) =>
        init?.method === 'PUT'
          ? Promise.resolve(new Response('forbidden', { status: 403 }))
          : Promise.resolve(
            Response.json({
              id: 71,
              seriesId: 7,
              seasonNumber: 1,
              episodeNumber: 2,
              monitored: true,
            }),
          )) as typeof fetch,
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
  },
);

Deno.test(
  'Radarr monitoring writes reconcile HTTP and transport errors through read-back',
  async () => {
    for (const failure of ['http', 'transport'] as const) {
      let monitored = true;
      let puts = 0;
      const client = new ArrClient(
        'radarr',
        'http://radarr:7878',
        'secret',
        ((
          _: string | URL | Request,
          init?: RequestInit,
        ) => {
          if (init?.method === 'PUT') {
            puts++;
            monitored = false;
            return failure === 'http'
              ? Promise.resolve(new Response('rejected', { status: 500 }))
              : Promise.reject(new TypeError('lost response'));
          }
          return Promise.resolve(
            Response.json({
              id: 42,
              tmdbId: 123,
              path: '/movies/Movie',
              monitored,
              qualityProfileId: 7,
            }),
          );
        }) as typeof fetch,
      );
      const identity = { movieId: 42, tmdbId: 123, path: '/movies/Movie' };
      assertEquals(await client.setRadarrMovieMonitored(identity, false), true);
      assertEquals(await client.setRadarrMovieMonitored(identity, false), false);
      assertEquals(puts, 1);
    }
  },
);

Deno.test('ArrClient treats failed monitoring read-back as inconclusive', async () => {
  for (const type of ['sonarr', 'radarr'] as const) {
    let reads = 0;
    const client = new ArrClient(
      type,
      `http://${type}`,
      'secret',
      ((
        _: string | URL | Request,
        init?: RequestInit,
      ) => {
        if (init?.method === 'PUT') {
          return Promise.resolve(new Response('rejected', { status: 503 }));
        }
        reads++;
        if (reads > 1) return Promise.reject(new TypeError('read-back unavailable'));
        return Promise.resolve(
          Response.json(
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
          ),
        );
      }) as typeof fetch,
    );
    const error = await assertRejects(
      () =>
        type === 'sonarr'
          ? client.setSonarrEpisodeMonitored(
            {
              episodeId: 71,
              seriesId: 7,
              seasonNumber: 1,
              episodeNumber: 2,
            },
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
      Promise.resolve(
        Response.json([
          {
            id: 7,
            title: 'Example',
            path: '/tv/Example',
            seasons: [
              {
                seasonNumber: 2,
                statistics: { episodeFileCount: 8, sizeOnDisk: 8000 },
              },
              {
                seasonNumber: 0,
                statistics: { episodeFileCount: 1, sizeOnDisk: 1000 },
              },
              {
                seasonNumber: 3,
                statistics: { episodeFileCount: 0, sizeOnDisk: 0 },
              },
              {
                seasonNumber: 1,
                statistics: { episodeFileCount: 10, sizeOnDisk: 10000 },
              },
            ],
          },
        ]),
      )) as typeof fetch,
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
    tmdbId: null,
    year: null,
    monitored: null,
  });
});

Deno.test('torrentAssociations keeps only imported BitTorrent download IDs', async () => {
  const mockFetch = (() =>
    Promise.resolve(
      Response.json([
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
      ]),
    )) as typeof fetch;
  const client = new ArrClient('radarr', 'http://radarr:7878', 'secret', mockFetch);
  assertEquals(await client.torrentAssociations(42), [
    {
      hash: 'a'.repeat(40),
      sourcePath: '/downloads/release/movie.mkv',
      payloadPath: '/downloads/release',
      importedPath: '/movies/Movie/movie.mkv',
      historyId: 9,
      date: '2026-01-01T00:00:00Z',
    },
  ]);
});

Deno.test('download history detects a hash associated with another Arr title', async () => {
  const exclusive = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() =>
      Promise.resolve(
        Response.json({
          totalRecords: 2,
          records: [{ movieId: 42 }, { movieId: 42 }],
        }),
      )) as typeof fetch,
  );
  assertEquals(await exclusive.downloadIdIsExclusiveTo(42, 'a'.repeat(40)), true);

  const shared = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    (() =>
      Promise.resolve(
        Response.json({
          totalRecords: 2,
          records: [{ seriesId: 7 }, { seriesId: 9 }],
        }),
      )) as typeof fetch,
  );
  assertEquals(await shared.downloadIdIsExclusiveTo(7, 'a'.repeat(40)), false);
});

Deno.test('Radarr lookup and extra files expose its managed deletion boundary', async () => {
  const mockFetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/movie?tmdbId=')) {
      return Promise.resolve(
        Response.json([
          {
            id: 42,
            title: 'Movie',
            path: 'A:\\Movies\\Movie',
          },
        ]),
      );
    }
    if (url.includes('/moviefile?movieId=')) {
      return Promise.resolve(
        Response.json([
          {
            id: 99,
            relativePath: 'Movie.mov',
            path: 'A:\\Movies\\Movie\\Movie.mov',
            size: 2000,
          },
        ]),
      );
    }
    return Promise.resolve(
      Response.json([
        { relativePath: 'Movie.idx', type: 'subtitle', movieFileId: null },
        { relativePath: 'Movie.sub', type: 0, movieFileId: null },
        { relativePath: 'movie.nfo', type: 1, movieFileId: null },
        { relativePath: 'extras/trailer.mov', type: 2, movieFileId: null },
      ]),
    );
  }) as typeof fetch;
  const client = new ArrClient('radarr', 'http://radarr:7878', 'secret', mockFetch);
  assertEquals(await client.lookup(550), {
    id: 42,
    title: 'Movie',
    path: 'A:\\Movies\\Movie',
    seasons: null,
    tmdbId: null,
    year: null,
    monitored: null,
  });
  assertEquals(await client.mediaFiles(42), [{ relativePath: 'Movie.mov', size: 2000 }]);
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

Deno.test('Radarr removal fallback never asks Radarr to delete files', async () => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const mockFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    if (url.includes('/exclusions') && init?.method === 'POST') {
      return Promise.resolve(Response.json({ id: 9 }));
    }
    if (url.includes('/exclusions')) {
      return Promise.resolve(
        Response.json({
          records: [{ id: 9, tmdbId: 550, movieTitle: 'Fight Club', movieYear: 1999 }],
        }),
      );
    }
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  const client = new ArrClient('radarr', 'http://radarr:7878', 'secret', mockFetch);

  assertEquals(await client.radarrImportExclusions(), [
    { id: 9, tmdbId: 550, movieTitle: 'Fight Club', movieYear: 1999 },
  ]);
  assertEquals(
    requests[0]?.url,
    'http://radarr:7878/api/v3/exclusions/paged?page=1&pageSize=1000&sortKey=movieTitle&sortDirection=ascending',
  );
  await client.createRadarrImportExclusion({
    tmdbId: 550,
    movieTitle: 'Fight Club',
    movieYear: 1999,
  });
  await client.removeRadarrMovieWithoutFiles(42);

  assertEquals(requests.at(-1), {
    url: 'http://radarr:7878/api/v3/movie/42?deleteFiles=false&addImportExclusion=true',
    method: 'DELETE',
  });
});

Deno.test('Radarr exact-ID absence distinguishes 404 from identity drift', async () => {
  for (
    const [response, expected] of [
      [new Response(null, { status: 404 }), false],
      [Response.json({ id: 42, tmdbId: 999 }), true],
    ] as const
  ) {
    const client = new ArrClient(
      'radarr',
      'http://radarr:7878',
      'secret',
      (() => Promise.resolve(response.clone())) as typeof fetch,
    );
    assertEquals(await client.radarrMovieExistsById(42), expected);
  }

  const conflicting = new ArrClient(
    'radarr',
    'http://radarr:7878',
    'secret',
    (() => Promise.resolve(Response.json({ id: 43 }))) as typeof fetch,
  );
  await assertRejects(
    () => conflicting.radarrMovieExistsById(42),
    ArrApiError,
    'conflicting or malformed targeted movie',
  );
});
