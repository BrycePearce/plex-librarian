import { assertEquals, assertRejects } from '@std/assert';
import { extractExternalIds, mapActiveSessions, PlexClient } from './client.ts';

Deno.test('extractExternalIds reads modern Plex GUID arrays', () => {
  assertEquals(
    extractExternalIds({ Guid: [{ id: 'tmdb://550' }, { id: 'tvdb://81189' }] }),
    { tmdbId: 550, tvdbId: 81189 },
  );
});

Deno.test('extractExternalIds reads legacy Plex agent GUIDs', () => {
  assertEquals(
    extractExternalIds({ guid: 'com.plexapp.agents.themoviedb://157336?lang=en' }),
    { tmdbId: 157336, tvdbId: null },
  );
  assertEquals(
    extractExternalIds({ guid: 'com.plexapp.agents.thetvdb://73244?lang=en' }),
    { tmdbId: null, tvdbId: 73244 },
  );
});

Deno.test('extractExternalIds ignores malformed provider IDs', () => {
  assertEquals(extractExternalIds({ Guid: [{ id: 'tmdb://nope' }] }), {
    tmdbId: null,
    tvdbId: null,
  });
});

Deno.test('mapActiveSessions normalizes Plex user, player, and network fields', () => {
  assertEquals(
    mapActiveSessions([{
      sessionKey: '42',
      ratingKey: '9001',
      type: 'episode',
      grandparentRatingKey: '8000',
      User: { id: '7', title: 'friend' },
      Player: {
        address: '203.0.113.12',
        machineIdentifier: 'player-uuid',
        title: 'Living Room TV',
        local: '0',
        state: 'paused',
      },
      Session: { id: 'session-id', location: 'wan' },
    }]),
    [{
      sessionKey: '42',
      ratingKey: '9001',
      type: 'episode',
      grandparentRatingKey: '8000',
      state: 'paused',
      accountId: 7,
      username: 'friend',
      playerUuid: 'player-uuid',
      playerTitle: 'Living Room TV',
      ip: '203.0.113.12',
      isLocal: false,
    }],
  );
});

Deno.test('item sync requests external GUIDs without adding them to episode streams', async () => {
  const urls: string[] = [];
  const mockFetch = ((input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(Response.json({
      MediaContainer: {
        totalSize: 1,
        Metadata: [{
          ratingKey: '10',
          title: 'Example',
          type: 'show',
          Guid: [{ id: 'tvdb://123' }],
        }],
      },
    }));
  }) as typeof fetch;
  const client = new PlexClient('http://plex:32400', 'token', undefined, mockFetch);

  const itemPage = await client.libraryItems('7', 2).next();
  assertEquals(itemPage.value?.items[0].tvdbId, 123);
  await client.libraryEpisodes('7').next();

  assertEquals(urls, [
    'http://plex:32400/library/sections/7/all?type=2&includeGuids=1',
    'http://plex:32400/library/sections/7/all?type=4',
  ]);
});

Deno.test('media path preview preserves and deduplicates multi-version movie Part paths', async () => {
  const urls: string[] = [];
  const mockFetch = ((input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(Response.json({
      MediaContainer: {
        Metadata: [{
          ratingKey: 'movie/key',
          title: 'Example',
          type: 'movie',
          Media: [
            {
              id: 1,
              Part: [{ file: 'C:\\Media\\Movie.mkv' }, { file: '\\\\nas\\Movies\\bonus.mkv' }],
            },
            { id: 2, Part: [{ file: '/movies/Movie-4K.mkv' }, { file: 'C:\\Media\\Movie.mkv' }] },
          ],
        }],
      },
    }));
  }) as typeof fetch;
  const client = new PlexClient('http://plex:32400', 'token', undefined, mockFetch);

  assertEquals(await client.mediaPathPreview('movie/key', 'movie'), {
    paths: ['C:\\Media\\Movie.mkv', '\\\\nas\\Movies\\bonus.mkv', '/movies/Movie-4K.mkv'],
    truncated: false,
  });
  assertEquals(urls, ['http://plex:32400/library/metadata/movie%2Fkey']);
});

Deno.test('show media path preview pages through live allLeaves metadata', async () => {
  const starts: string[] = [];
  const mockFetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const start = headers.get('X-Plex-Container-Start') ?? '0';
    starts.push(start);
    const second = start === '1';
    return Promise.resolve(Response.json({
      MediaContainer: {
        totalSize: 2,
        Metadata: [{
          ratingKey: second ? 'episode-2' : 'episode-1',
          title: 'Episode',
          type: 'episode',
          Media: [{ Part: [{ file: second ? '/tv/show/e02.mkv' : '/tv/show/e01.mkv' }] }],
        }],
      },
    }));
  }) as typeof fetch;
  const client = new PlexClient('http://plex:32400', 'token', undefined, mockFetch);

  assertEquals(await client.mediaPathPreview('show-1', 'show'), {
    paths: ['/tv/show/e01.mkv', '/tv/show/e02.mkv'],
    truncated: false,
  });
  assertEquals(starts, ['0', '1']);
});

Deno.test('media path preview caps large leaf collections and reports truncation', async () => {
  const mockFetch = (() =>
    Promise.resolve(Response.json({
      MediaContainer: {
        totalSize: 3,
        Metadata: [{
          ratingKey: 'track',
          title: 'Track',
          type: 'track',
          Media: [{
            Part: [{ file: '/music/1.flac' }, { file: '/music/2.flac' }, { file: '/music/3.flac' }],
          }],
        }],
      },
    }))) as typeof fetch;
  const client = new PlexClient('http://plex:32400', 'token', undefined, mockFetch);

  assertEquals(await client.mediaPathPreview('artist-1', 'artist', 2), {
    paths: ['/music/1.flac', '/music/2.flac'],
    truncated: true,
  });
});

Deno.test('media path preview bounds leaf scans when Plex omits every Part path', async () => {
  let requests = 0;
  const mockFetch = (() => {
    requests++;
    return Promise.resolve(Response.json({
      MediaContainer: {
        totalSize: 1_000_000,
        Metadata: Array.from({ length: 300 }, (_, index) => ({
          ratingKey: String(index),
          title: 'Episode',
          type: 'episode',
          Media: [{ Part: [{ size: 100 }] }],
        })),
      },
    }));
  }) as typeof fetch;
  const client = new PlexClient('http://plex:32400', 'token', undefined, mockFetch);

  assertEquals(await client.mediaPathPreview('show-1', 'show', 10), {
    paths: [],
    truncated: true,
  });
  assertEquals(requests, 1);
});

Deno.test('media path preview forwards caller cancellation without retrying', async () => {
  let requests = 0;
  const mockFetch = ((_input: string | URL | Request, init?: RequestInit) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  const client = new PlexClient('http://plex:32400', 'token', undefined, mockFetch);
  const controller = new AbortController();
  const preview = client.mediaPathPreview('movie-1', 'movie', 10, controller.signal);

  controller.abort(new DOMException('preview cancelled', 'AbortError'));

  await assertRejects(() => preview, DOMException, 'preview cancelled');
  assertEquals(requests, 1);
});

Deno.test('media path preview cancellation interrupts retry backoff', async () => {
  let requests = 0;
  let firstRequest!: () => void;
  const requested = new Promise<void>((resolve) => firstRequest = resolve);
  const mockFetch = (() => {
    requests++;
    firstRequest();
    return Promise.reject(new TypeError('connection reset'));
  }) as typeof fetch;
  const client = new PlexClient('http://plex:32400', 'token', undefined, mockFetch);
  const controller = new AbortController();
  const startedAt = performance.now();
  const preview = client.mediaPathPreview('movie-1', 'movie', 10, controller.signal);

  await requested;
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new DOMException('preview cancelled in backoff', 'AbortError'));

  await assertRejects(() => preview, DOMException, 'preview cancelled in backoff');
  assertEquals(requests, 1);
  // The first retry delay is at least one second. Cancellation should settle without
  // waiting for that timer, while leaving generous headroom for a busy test runner.
  assertEquals(performance.now() - startedAt < 500, true);
});
