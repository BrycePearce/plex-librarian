import { assertEquals, assertRejects } from '@std/assert';
import {
  ARR_ROOT_FOLDERS_MAX_BYTES,
  ARR_ROOT_FOLDERS_MAX_RECORDS,
  ArrApiError,
  ArrClient,
  normalizeArrUrl,
  RADARR_CATALOG_MAX_BYTES,
  RADARR_CATALOG_MAX_RECORDS,
} from './client.ts';

Deno.test('Radarr extra scope rejects unsafe paths and incomplete bounded reads', async () => {
  for (
    const relativePath of [
      '../outside.srt',
      '/absolute.srt',
      'C:\\outside.srt',
      'a//b.srt',
      ' a.srt',
      4,
    ]
  ) {
    const client = new ArrClient(
      'radarr',
      'http://fixture.invalid',
      'fixture-key',
      (() => Promise.resolve(Response.json([{ relativePath, movieFileId: 42 }]))) as typeof fetch,
    );
    await assertRejects(() => client.extraFiles(1), ArrApiError, 'extra-file record');
  }
  const tooMany = new ArrClient(
    'radarr',
    'http://fixture.invalid',
    'fixture-key',
    (() =>
      Promise.resolve(
        Response.json(
          Array.from(
            { length: RADARR_CATALOG_MAX_RECORDS + 1 },
            () => ({ relativePath: 'file.srt', movieFileId: 42 }),
          ),
        ),
      )) as typeof fetch,
  );
  await assertRejects(() => tooMany.extraFiles(1), ArrApiError, 'extra-file response');
  const tooLarge = new ArrClient(
    'radarr',
    'http://fixture.invalid',
    'fixture-key',
    (() =>
      Promise.resolve(
        new Response(' '.repeat(RADARR_CATALOG_MAX_BYTES + 1)),
      )) as typeof fetch,
  );
  await assertRejects(() => tooLarge.extraFiles(1), ArrApiError);
  const failed = new ArrClient(
    'radarr',
    'http://fixture.invalid',
    'fixture-key',
    (() => Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch,
  );
  await assertRejects(() => failed.extraFiles(1), ArrApiError);
});

Deno.test('catalog-only Arr deletion never requests directory file removal', async () => {
  for (const type of ['sonarr', 'radarr'] as const) {
    const requests: Array<{ url: string; method: string | undefined }> = [];
    const client = new ArrClient(
      type,
      'http://fixture.invalid',
      'fixture-key',
      ((input, init) => {
        requests.push({ url: String(input), method: init?.method });
        return Promise.resolve(new Response(null, { status: 202 }));
      }) as typeof fetch,
    );
    const outcomes: unknown[] = [];
    await client.deleteManagedRecord(42, false, (outcome) => outcomes.push(outcome));
    assertEquals(requests, [{
      url: `http://fixture.invalid/api/v3/${
        type === 'radarr' ? 'movie' : 'series'
      }/42?deleteFiles=false&${
        type === 'radarr' ? 'addImportExclusion' : 'addImportListExclusion'
      }=false`,
      method: 'DELETE',
    }]);
    assertEquals(outcomes, [{ status: 'accepted', httpStatus: 202 }]);
    await assertRejects(
      () => client.deleteManagedRecord(-1, false),
      ArrApiError,
      'positive managed record ID',
    );
    assertEquals(requests.length, 1);
  }
});

Deno.test('remote mapping suggestions preserve their download-client host and omit unscoped records', async () => {
  const client = new ArrClient(
    'sonarr',
    'http://fixture.invalid',
    'fixture-key',
    (() =>
      Promise.resolve(Response.json([
        { host: 'qb-one', remotePath: '/downloads', localPath: '/data/downloads' },
        { host: 'qb-two', remotePath: '/downloads', localPath: '/other/downloads' },
        { remotePath: '/unscoped', localPath: '/data/unscoped' },
        { host: '', remotePath: '/empty', localPath: '/data/empty' },
      ]))) as typeof fetch,
  );
  assertEquals(await client.remotePathHints(), [
    { host: 'qb-one', remotePath: '/downloads', localPath: '/data/downloads' },
    { host: 'qb-two', remotePath: '/downloads', localPath: '/other/downloads' },
  ]);
});

Deno.test('ArrClient reads Sonarr and Radarr root folders in stable order with duplicates', async () => {
  const response = [
    { id: 2, path: ' /data/TV ' },
    { id: 3, path: '/data/Anime' },
    { id: 4, path: '/data/TV' },
  ];
  for (const type of ['sonarr', 'radarr'] as const) {
    const requests: string[] = [];
    const client = new ArrClient(
      type,
      `http://${type}`,
      'secret',
      ((input: string | URL | Request) => {
        requests.push(String(input));
        return Promise.resolve(Response.json(response));
      }) as typeof fetch,
    );
    assertEquals(await client.rootFolders(), [
      { id: 2, path: '/data/TV' },
      { id: 3, path: '/data/Anime' },
      { id: 4, path: '/data/TV' },
    ]);
    assertEquals(requests, [`http://${type}/api/v3/rootfolder`]);
  }
});

Deno.test('ArrClient root-folder validation is all-or-nothing and bounded', async () => {
  for (
    const response of [
      [{ id: 1, path: '/valid' }, { id: 0, path: '/invalid' }],
      Array.from({ length: ARR_ROOT_FOLDERS_MAX_RECORDS + 1 }, (_, index) => ({
        id: index + 1,
        path: `/root/${index}`,
      })),
    ]
  ) {
    const client = new ArrClient(
      'sonarr',
      'http://sonarr',
      'secret',
      (() => Promise.resolve(Response.json(response))) as typeof fetch,
    );
    await assertRejects(() => client.rootFolders(), ArrApiError);
  }

  const oversized = JSON.stringify([{ id: 1, path: `/${'x'.repeat(ARR_ROOT_FOLDERS_MAX_BYTES)}` }]);
  const client = new ArrClient(
    'radarr',
    'http://radarr',
    'secret',
    (() => Promise.resolve(new Response(oversized))) as typeof fetch,
  );
  await assertRejects(() => client.rootFolders(), ArrApiError, 'byte safety limit');
});

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

Deno.test('ArrClient uses Sonarr TVDB lookup and list exclusion parameter', async () => {
  const urls: string[] = [];
  const mockFetch = ((input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(
      String(input).includes('/series?')
        ? Response.json([{ id: 7, title: 'Example', titleSlug: 'example' }])
        : Response.json({}),
    );
  }) as typeof fetch;
  const client = new ArrClient('sonarr', 'http://sonarr:8989', 'secret', mockFetch);
  assertEquals((await client.lookup(123))?.titleSlug, 'example');
  await client.deleteMedia(7, false);
  assertEquals(urls, [
    'http://sonarr:8989/api/v3/series?tvdbId=123',
    'http://sonarr:8989/api/v3/series/7?deleteFiles=true&addImportListExclusion=false',
  ]);
});

Deno.test('ArrClient requires explicit empty file ownership for post-deletion monitoring', async () => {
  for (const episodeFileId of [undefined, null, '0', 999, 0]) {
    let writes = 0, monitored = true;
    const client = new ArrClient(
      'sonarr',
      'http://sonarr.invalid',
      'test',
      ((_input, init) => {
        if (init?.method === 'PUT') {
          writes++;
          monitored = false;
        }
        return Promise.resolve(Response.json({
          id: 71,
          seriesId: 7,
          seasonNumber: 1,
          episodeNumber: 2,
          monitored,
          episodeFileId,
        }));
      }) as typeof fetch,
    );
    const update = () =>
      client.setSonarrEpisodeMonitored(
        {
          episodeId: 71,
          seriesId: 7,
          seasonNumber: 1,
          episodeNumber: 2,
        },
        false,
        undefined,
        true,
      );
    if (episodeFileId === 0) assertEquals(await update(), true);
    else await assertRejects(update, Error, 'monitoring is held');
    assertEquals(writes, episodeFileId === 0 ? 1 : 0);
  }
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
  const responses: unknown[] = [];
  assertEquals(
    await client.setSonarrEpisodeMonitored(identity, false, (response) => responses.push(response)),
    true,
  );
  assertEquals(responses, [{ status: 'succeeded', httpStatus: 200 }]);
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

Deno.test('Radarr imported file provenance comes only from bounded historical FileId evidence', async () => {
  const urls: string[] = [];
  const records = [{ fileId: '41' }, { FileId: '42' }, { fileId: '43', FileId: '43' }, {}];
  const client = new ArrClient(
    'radarr',
    'http://fixture.invalid',
    'fixture-key',
    ((input) => {
      urls.push(String(input));
      return Promise.resolve(Response.json(records.map((data, index) => ({
        id: index + 1,
        eventType: 'downloadFolderImported',
        downloadId: 'a'.repeat(40),
        data,
      }))));
    }) as typeof fetch,
  );
  assertEquals((await client.torrentAssociations(7)).map((record) => record.movieFileId), [
    41,
    42,
    43,
    undefined,
  ]);
  assertEquals(urls, ['http://fixture.invalid/api/v3/history/movie?movieId=7&includeMovie=false']);
  for (
    const data of [
      { fileId: '0' },
      { fileId: 42 },
      { fileId: ' 42' },
      { fileId: '4.2' },
      { fileId: '9007199254740992' },
      { fileId: '41', FileId: '42' },
      [],
      null,
    ]
  ) {
    const malformed = new ArrClient(
      'radarr',
      'http://fixture.invalid',
      'fixture-key',
      (() =>
        Promise.resolve(
          Response.json([{
            eventType: 'downloadFolderImported',
            downloadId: 'a'.repeat(40),
            data,
          }]),
        )) as typeof fetch,
    );
    await assertRejects(() => malformed.torrentAssociations(7), ArrApiError, 'ownership');
  }
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

Deno.test('Sonarr torrent associations preserve multi-episode import owners and file conflicts', async () => {
  const records = [
    { id: 1, episodeId: 11, data: { fileId: '30' } },
    { id: 2, episodeId: 12, data: { FileId: '30' } },
    { id: 3, episodeId: 12, data: { fileId: '31', FileId: '31' } },
  ].map((record) => ({
    ...record,
    eventType: 'downloadFolderImported',
    downloadId: 'a'.repeat(40),
    data: {
      ...record.data,
      droppedPath: '/downloads/pack/double.mkv',
      importedPath: '/tv/Show/double.mkv',
    },
  }));
  const client = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    (() => Promise.resolve(Response.json(records))) as typeof fetch,
  );
  const associations = await client.torrentAssociations(42);
  assertEquals(
    associations.map(({ historyId, episodeId, episodeFileId }) => ({
      historyId,
      episodeId,
      episodeFileId,
    })),
    [
      { historyId: 1, episodeId: 11, episodeFileId: 30 },
      { historyId: 2, episodeId: 12, episodeFileId: 30 },
      { historyId: 3, episodeId: 12, episodeFileId: 31 },
    ],
  );
});

Deno.test('Sonarr torrent associations never assert malformed or missing import provenance', async () => {
  const malformed = [undefined, null, 0, -1, 1.5, true, {}, [], '12', Number.MAX_SAFE_INTEGER + 1];
  const malformedFileIds = [
    undefined,
    null,
    0,
    12,
    true,
    {},
    [],
    '',
    '0',
    '-1',
    '1.5',
    '1e2',
    ' 12',
    '12 ',
    '012',
    '12junk',
    '9007199254740992',
  ];
  const records = [
    ...malformed.map((episodeId) => ({ episodeId, data: {} })),
    ...malformedFileIds.map((fileId) => ({ data: { fileId } })),
    { data: { fileId: '12', FileId: '13' } },
    { data: { fileId: '12', FileId: null } },
  ].map((record, index) => ({
    ...record,
    eventType: 'downloadFolderImported',
    downloadId: 'a'.repeat(40),
    data: { ...record.data, droppedPath: `/downloads/file-${index}.mkv` },
  }));
  const client = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    (() => Promise.resolve(Response.json(records))) as typeof fetch,
  );
  const associations = await client.torrentAssociations(42);
  assertEquals(associations.length, records.length);
  for (const association of associations) {
    assertEquals(Object.hasOwn(association, 'episodeId'), false);
    assertEquals(Object.hasOwn(association, 'episodeFileId'), false);
  }
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

Deno.test('Sonarr media files adapt exact bounded EpisodeFile identities', async () => {
  const client = new ArrClient(
    'sonarr',
    'http://sonarr:8989',
    'secret',
    ((input) => {
      const path = new URL(String(input)).pathname;
      return Promise.resolve(Response.json(
        path.endsWith('/episode')
          ? [{
            id: 11,
            seriesId: 7,
            seasonNumber: 1,
            episodeNumber: 1,
            episodeFileId: 90,
            monitored: true,
          }]
          : [{
            id: 90,
            seriesId: 7,
            path: '/tv/Show/S01E01.mkv',
            relativePath: 'Season 1/S01E01.mkv',
            size: 2000,
          }],
      ));
    }) as typeof fetch,
  );
  assertEquals(await client.mediaFiles(7), [{
    id: 90,
    path: '/tv/Show/S01E01.mkv',
    relativePath: 'Season 1/S01E01.mkv',
    size: 2000,
  }]);
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

Deno.test('Sonarr series snapshot derives exact EpisodeFile ownership and rejects shared files', async () => {
  const client = new ArrClient('sonarr', 'http://sonarr', 'key', (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/episode')) {
      return Promise.resolve(Response.json([
        {
          id: 11,
          seriesId: 7,
          seasonNumber: 1,
          episodeNumber: 1,
          episodeFileId: 90,
          monitored: true,
        },
        {
          id: 12,
          seriesId: 7,
          seasonNumber: 1,
          episodeNumber: 2,
          episodeFileId: 90,
          monitored: false,
        },
      ]));
    }
    return Promise.resolve(Response.json([
      { id: 90, seriesId: 7, path: '/tv/Show/shared.mkv', relativePath: 'shared.mkv', size: 100 },
    ]));
  });
  const snapshot = await client.sonarrSeriesSnapshot(7);
  assertEquals(snapshot.files[0]?.episodeIds, [11, 12]);
});

Deno.test('Sonarr targeted EpisodeFile ownership is exact and rejects cross-series records', async () => {
  const valid = new ArrClient('sonarr', 'http://sonarr', 'key', (input) => {
    const url = new URL(String(input));
    assertEquals(url.searchParams.get('episodeFileId'), '90');
    return Promise.resolve(Response.json([
      { id: 12, seriesId: 7, episodeFileId: 90 },
      { id: 11, seriesId: 7, episodeFileId: 90 },
    ]));
  });
  assertEquals(await valid.sonarrEpisodeFileOwnerIds(90, 7), [11, 12]);

  const drifted = new ArrClient(
    'sonarr',
    'http://sonarr',
    'key',
    () => Promise.resolve(Response.json([{ id: 11, seriesId: 8, episodeFileId: 90 }])),
  );
  await assertRejects(
    () => drifted.sonarrEpisodeFileOwnerIds(90, 7),
    ArrApiError,
    'conflicting EpisodeFile ownership',
  );
});
