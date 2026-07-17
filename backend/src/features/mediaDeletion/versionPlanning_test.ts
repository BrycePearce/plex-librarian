import { assertEquals, assertStringIncludes } from '@std/assert';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import { buildVersionDeletionPlan } from './versionPlanning.ts';

function target(files: string[]): ArrDeleteTarget {
  return {
    instanceId: 1,
    instanceName: 'Radarr 4K',
    addImportExclusion: true,
    pathMappings: [],
    client: {
      type: 'radarr',
      lookup: () =>
        Promise.resolve({ id: 7, title: 'Movie', path: '/movies/Movie', seasons: null }),
      mediaFiles: () => Promise.resolve(files.map((relativePath) => ({ relativePath, size: 100 }))),
      extraFiles: () => Promise.resolve([]),
    },
  } as unknown as ArrDeleteTarget;
}

const item = {
  title: 'Movie',
  type: 'movie',
  tmdbId: 10,
  tvdbId: null,
};

Deno.test('version plan enables Radarr only when its complete folder maps to selected paths', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/other/Movie/kept.mkv'], truncated: false },
    ],
    arrTargets: [target(['selected.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrStatus, 'resolved');
  assertEquals(plan.eligibleArrTargets.length, 1);
});

Deno.test('version plan rejects Radarr when an unselected Plex version shares its folder', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/kept.mkv'], truncated: false },
    ],
    arrTargets: [target(['selected.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReason ?? '', 'unselected version');
});

Deno.test('episode version plan never authorizes series-wide Sonarr deletion', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'episode',
    item: { ...item, type: 'show', tmdbId: null, tvdbId: 20 },
    selectedMediaIds: new Set([1]),
    liveVersions: [{ mediaId: 1, paths: ['/tv/Show/Episode.mkv'], truncated: false }],
    arrTargets: [target(['Episode.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: true,
  });

  assertEquals(plan.preview.arrStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReason ?? '', 'series-wide');
  assertEquals(plan.preview.cleanupStatus, 'unavailable');
});
