import { assertEquals, assertRejects } from '@std/assert';
import {
  assertRetainedPlexScope,
  retainedPlexBatchCheck,
  type RetainedPlexScopeInput,
} from './ordinaryScope.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';

function fixture() {
  const scans: string[] = [];
  let retained = false;
  const plex = {
    libraries: () =>
      Promise.resolve([{ key: 'tv', type: 'show' }, { key: 'movies', type: 'movie' }]),
    libraryLocations: (key: string) =>
      Promise.resolve({ locations: [{ path: key === 'tv' ? '/tv' : '/movies' }] }),
    async *libraryFileEntries(key: string) {
      scans.push(key);
      for (let page = 0; page < 100; page++) {
        yield retained
          ? [{ ratingKey: 'retained', showRatingKey: 'retained', path: '/tv/Selected/shared.mkv' }]
          : [];
      }
    },
  } as unknown as PlexClient;
  const roots = [['plex:tv', '/tv', '/storage/tv'], ['plex:movies', '/movies', '/storage/movies']]
    .map(([serviceKey, serviceRoot, storageRoot], index) => ({
      id: index + 1,
      serverId: 1,
      serviceKey,
      configurationIdentity: serviceKey,
      serviceRoot,
      storageRoot,
      caseSensitive: true,
      hasAliases: false,
      revision: 1,
    }));
  const input: RetainedPlexScopeInput = {
    plex,
    libraryKey: 'tv',
    selection: { ratingKey: 'selected', title: 'Selected', type: 'show', tmdbId: null, tvdbId: 1 },
    roots,
    mapped: true,
    scopes: [{ path: '/storage/tv/Selected', directory: true }],
  };
  return {
    input,
    scans,
    setRetained: () => {
      retained = true;
    },
  };
}
Deno.test('retained inspection streams only libraries whose confirmed current roots can intersect', async () => {
  const { input, scans } = fixture();
  await assertRetainedPlexScope(input);
  assertEquals(scans, ['tv']);
});
Deno.test('missing library-root discovery falls back to complete inspection, not unverified exclusion', async () => {
  const { input, scans } = fixture();
  input.plex.libraryLocations = () => Promise.reject(new Error('Unavailable roots'));
  await assertRetainedPlexScope(input);
  assertEquals(scans, ['tv', 'movies']);
});
Deno.test('negative retained evidence expires and is never reused across service batches or worker passes', async () => {
  for (const boundary of ['phase', 'time', 'pass'] as const) {
    const { input, scans, setRetained } = fixture();
    let phase = 'files', now = 1;
    let check = retainedPlexBatchCheck(() => phase, () => now);
    await check(input);
    await check(input);
    assertEquals(scans.length, 1);
    setRetained();
    if (boundary === 'phase') phase = 'plex';
    if (boundary === 'time') now = 10001;
    if (boundary === 'pass') check = retainedPlexBatchCheck(() => phase, () => now);
    await assertRejects(() => check(input), Error, 'retained in Plex');
    assertEquals(scans.length, 2);
  }
});

Deno.test('root pruning cannot conceal a retained entry under a conflicting nested library relationship', async () => {
  const { input, scans } = fixture();
  input.roots.push({
    ...input.roots[0],
    id: 3,
    serviceKey: 'plex:empty',
    serviceRoot: '/movies/Other',
    storageRoot: '/storage/tv/Selected',
  });
  input.plex.libraries = () =>
    Promise.resolve(
      [{ key: 'tv', type: 'show' }, { key: 'movies', type: 'movie' }, {
        key: 'empty',
        type: 'movie',
      }] as Awaited<ReturnType<PlexClient['libraries']>>,
    );
  input.plex.libraryFileEntries = async function* (key) {
    scans.push(key);
    yield key === 'movies' ? [{ ratingKey: 'retained', path: '/movies/Other/shared.mkv' }] : [];
  };
  await assertRejects(() => assertRetainedPlexScope(input), Error, 'relationships disagree');
  assertEquals(scans.includes('movies'), true);
});
Deno.test('saved section roots remain in the exclusion check while Plex still reports files at their old prefix', async () => {
  const { input } = fixture();
  input.plex.libraryLocations = () =>
    Promise.resolve(
      { locations: [{ id: 1, path: '/new-root' }] } as Awaited<
        ReturnType<PlexClient['libraryLocations']>
      >,
    );
  input.plex.libraryFileEntries = async function* () {
    yield [{ ratingKey: 'retained', path: '/tv/Selected/shared.mkv' }];
  };
  await assertRejects(() => assertRetainedPlexScope(input), Error, 'retained in Plex');
});
