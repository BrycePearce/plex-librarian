import { assertEquals } from '@std/assert';
import type { PlexClient, PlexLibrary } from '../../integrations/plex/index.ts';
import { syncShowSizes } from './mediaRollups.ts';
import { completeProjectionPrune } from './service.ts';

Deno.test('empty episode stream explicitly reports show projection prune incomplete', async () => {
  const plex = {
    async *libraryEpisodes() {
      yield { episodes: [], episodeMediaVersions: [] };
    },
  } as unknown as PlexClient;
  const library = {
    key: 'shows',
    title: 'Shows',
    type: 'show',
  } as PlexLibrary;

  assertEquals(await syncShowSizes(plex, library, 100, 1), { pruneCompleted: false });
});

Deno.test('library prune receipts require every projection applicable to that type', () => {
  assertEquals(completeProjectionPrune('movie', true, false), true);
  assertEquals(completeProjectionPrune('movie', false, true), false);
  assertEquals(completeProjectionPrune('show', true, false), false);
  assertEquals(completeProjectionPrune('show', false, true), false);
  assertEquals(completeProjectionPrune('show', true, true), true);
  assertEquals(completeProjectionPrune('artist', true, true), false);
});
