import { assertEquals } from '@std/assert';
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
