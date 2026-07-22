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
      monitorTarget: () => Promise.resolve({ id: 7, monitored: true }),
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
  assertEquals(plan.preview.versions[0]?.arrPaths, ['/movies/Movie/selected.mkv']);
  assertEquals(plan.preview.versions[0]?.cleanupPaths, []);
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
  assertEquals(plan.preview.arrSelectionMatched, true);
});

Deno.test('version plan reports no Radarr match for an unmanaged Plex copy', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/unmanaged/Movie/copy.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/managed.mkv'], truncated: false },
    ],
    arrTargets: [target(['managed.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrStatus, 'unavailable');
  assertEquals(plan.preview.arrSelectionMatched, false);
});

Deno.test('version plan reports Radarr applicability per selected version in a mixed batch', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1, 2]),
    liveVersions: [
      { mediaId: 1, paths: ['/unmanaged/Movie/copy.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/managed.mkv'], truncated: false },
      { mediaId: 3, paths: ['/kept/Movie/kept.mkv'], truncated: false },
    ],
    arrTargets: [target(['managed.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
    allowPartialCoverage: true,
  });

  assertEquals(plan.preview.arrStatus, 'resolved');
  assertEquals(plan.eligibleArrTargets.length, 1);
  assertEquals(
    plan.preview.versions.map((version) => [version.mediaId, version.arrStatus]),
    [[1, 'unavailable'], [2, 'resolved']],
  );
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
  assertEquals(plan.preview.arrSelectionMatched, false);
  assertEquals(plan.preview.cleanupStatus, 'unavailable');
});
