import { assertEquals, assertStringIncludes } from '@std/assert';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import { buildVersionDeletionPlan } from './versionPlanning.ts';

function target(files: string[]): ArrDeleteTarget {
  return {
    instanceId: 1,
    instanceName: 'Radarr 4K',
    instanceType: 'radarr',
    instanceUrl: 'http://radarr',
    configurationUpdatedAt: 1,
    mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
    addImportExclusion: true,
    pathMappings: [],
    client: {
      type: 'radarr',
      lookup: () =>
        Promise.resolve({ id: 7, title: 'Movie', path: '/movies/Movie', seasons: null }),
      monitorTarget: () => Promise.resolve({ id: 7, monitored: true }),
      mediaFiles: () =>
        Promise.resolve(
          files.map((relativePath) => ({
            relativePath,
            size: 100,
          })),
        ),
      radarrManagedFile: () => {
        const relativePath = files[0];
        return Promise.resolve(
          relativePath
            ? {
              id: 1,
              relativePath,
              path: `/movies/Movie/${relativePath}`,
              size: 100,
            }
            : null,
        );
      },
      extraFiles: () => Promise.resolve([]),
    },
  } as unknown as ArrDeleteTarget;
}

function sonarrTarget(): ArrDeleteTarget {
  return {
    instanceId: 2,
    instanceName: 'Sonarr',
    instanceType: 'sonarr',
    instanceUrl: 'http://sonarr',
    configurationUpdatedAt: 1,
    mappingIdentity: '{"addImportExclusion":false,"pathMappings":[]}',
    addImportExclusion: false,
    pathMappings: [],
    client: {
      type: 'sonarr',
      lookup: () => Promise.resolve({ id: 8, title: 'Show', path: '/tv/Show', seasons: null }),
      episodeManagedFile: () =>
        Promise.resolve({
          episodeId: 9,
          file: {
            id: 10,
            relativePath: 'Season 01/old.mkv',
            path: '/tv/Show/Season 01/old.mkv',
            size: 100,
          },
        }),
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
  assertEquals(plan.preview.arrReassignStatus, 'resolved');
  assertEquals(plan.arrManagedMediaIds, [1]);
  assertEquals(plan.arrReassignCandidateMediaIds, [2]);
});

Deno.test('version plan carries a safe Radarr root for every retained movie copy', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/1080p.mkv'], truncated: false },
      { mediaId: 3, paths: ['/movies-4k/Movie/2160p.mkv'], truncated: false },
    ],
    arrTargets: [target(['selected.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'resolved');
  assertEquals(plan.arrManagedMediaIds, [1]);
  assertEquals(plan.arrReassignCandidateMediaIds, [2, 3]);
  assertEquals(
    [...plan.eligibleArrReassignments[0]!.candidateRecordPaths],
    [[2, '/movies/Movie'], [3, '/movies-4k/Movie']],
  );
});

Deno.test('version reassignment resolves Plex paths through the Arr library mapping', async () => {
  const mappedTarget = target(['selected.mkv']);
  mappedTarget.pathMappings = [{
    kind: 'library',
    arrPath: 'D:\\Movies',
    localPath: '/media/movies',
  }, {
    kind: 'download',
    arrPath: 'D:\\Downloads',
    localPath: '/downloads',
  }];
  mappedTarget.client.lookup = () =>
    Promise.resolve({ id: 7, title: 'Movie', path: 'D:\\Movies\\Movie', seasons: null });
  mappedTarget.client.radarrManagedFile = () =>
    Promise.resolve({
      id: 1,
      relativePath: 'selected.mkv',
      path: 'D:\\Movies\\Movie\\selected.mkv',
      size: 100,
    });

  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      {
        mediaId: 1,
        paths: ['/media/movies/Movie/selected.mkv'],
        truncated: false,
        fileSize: 100,
      },
      {
        mediaId: 2,
        paths: ['/media/movies/Movie/retained.mkv'],
        truncated: false,
        fileSize: 200,
      },
    ],
    arrTargets: [mappedTarget],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'resolved');
  assertEquals(plan.arrManagedMediaIds, [1]);
  assertEquals(
    plan.eligibleArrReassignments[0]?.candidatePaths.get(2),
    'D:\\Movies\\Movie\\retained.mkv',
  );
  assertEquals(
    plan.eligibleArrReassignments[0]?.candidateRecordPaths.get(2),
    'D:\\Movies\\Movie',
  );
  assertEquals(plan.eligibleArrReassignments[0]?.candidateFileSizes.get(2), 200);
});

Deno.test('version ownership fails closed when a selected Plex path is not covered by Arr mappings', async () => {
  const mappedTarget = target(['selected.mkv']);
  mappedTarget.pathMappings = [{
    kind: 'library',
    arrPath: 'D:\\Movies',
    localPath: '/media/movies',
  }];
  mappedTarget.client.lookup = () =>
    Promise.resolve({ id: 7, title: 'Movie', path: 'D:\\Movies\\Movie', seasons: null });
  mappedTarget.client.radarrManagedFile = () =>
    Promise.resolve({
      id: 1,
      relativePath: 'selected.mkv',
      path: 'D:\\Movies\\Movie\\selected.mkv',
      size: 100,
    });

  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/uncovered/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/media/movies/Movie/retained.mkv'], truncated: false },
    ],
    arrTargets: [mappedTarget],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.arrOwnershipValid, false);
  assertStringIncludes(plan.arrOwnershipReason ?? '', 'ownership could not be resolved safely');
  assertEquals(plan.arrManagedMediaIds, []);
});

Deno.test('episode ownership fails closed when Sonarr returns a malformed managed path', async () => {
  const malformed = sonarrTarget();
  malformed.client.episodeManagedFile = () =>
    Promise.resolve({
      episodeId: 9,
      file: {
        id: 10,
        relativePath: 'Season 01/old.mkv',
        path: 'old.mkv',
        size: 100,
      },
    });

  const plan = await buildVersionDeletionPlan({
    mediaType: 'episode',
    item: {
      title: 'Pilot',
      type: 'episode',
      tmdbId: null,
      tvdbId: 20,
    },
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/tv/Show/Season 01/old.mkv'], truncated: false },
      { mediaId: 2, paths: ['/tv/Show/Season 01/retained.mkv'], truncated: false },
    ],
    arrTargets: [malformed],
    resolvedCleanup: null,
    cleanupConfigured: false,
    episodeIdentity: { seasonNumber: 1, episodeNumber: 1 },
  });

  assertEquals(plan.arrOwnershipValid, false);
  assertStringIncludes(plan.arrOwnershipReason ?? '', 'ownership could not be resolved safely');
  assertEquals(plan.arrManagedMediaIds, []);
});

Deno.test('version reassignment never retains another version selected in the same operation', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    excludedReassignMediaIds: new Set([1, 2]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/also-deleting.mkv'], truncated: false },
      { mediaId: 3, paths: ['/movies/Movie/retained.mkv'], truncated: false },
    ],
    arrTargets: [target(['selected.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'resolved');
  assertEquals(plan.arrReassignCandidateMediaIds, [3]);
});

Deno.test('version reassignment rejects a Plex path shared by selected and retained versions', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/shared.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/shared.mkv'], truncated: false },
    ],
    arrTargets: [target(['shared.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'multiple Plex versions');
});

Deno.test('version reassignment rejects a selected Plex version with multiple file paths', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      {
        mediaId: 1,
        paths: ['/movies/Movie/selected.mkv', '/movies/Movie/selected-part-2.mkv'],
        truncated: false,
      },
      { mediaId: 2, paths: ['/movies/Movie/retained.mkv'], truncated: false },
    ],
    arrTargets: [target(['selected.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.arrManagedMediaIds, [1]);
  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'one exact file path');
});

Deno.test('version reassignment fails closed when any mapped Arr lookup fails', async () => {
  const unavailableTarget = {
    ...target(['selected.mkv']),
    instanceId: 2,
    instanceName: 'Unavailable Radarr',
    client: {
      ...target(['selected.mkv']).client,
      lookup: () => Promise.reject(new Error('connection failed')),
    },
  } as unknown as ArrDeleteTarget;
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/retained.mkv'], truncated: false },
    ],
    arrTargets: [target(['selected.mkv']), unavailableTarget],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'error');
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'connection failed');
});

Deno.test('Radarr reassignment does not adopt a version managed by another instance', async () => {
  const retainedOwner = target(['retained.mkv']);
  retainedOwner.instanceId = 2;
  retainedOwner.instanceName = 'Radarr HD';
  retainedOwner.instanceUrl = 'http://radarr-hd';
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/retained.mkv'], truncated: false },
    ],
    arrTargets: [target(['selected.mkv']), retainedOwner],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertEquals(plan.arrReassignCandidateMediaIds, []);
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'another mapped Arr instance');
});

Deno.test('Radarr reassignment can choose an unowned copy beside another managed version', async () => {
  const retainedOwner = target(['retained.mkv']);
  retainedOwner.instanceId = 2;
  retainedOwner.instanceName = 'Radarr HD';
  retainedOwner.instanceUrl = 'http://radarr-hd';
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/retained.mkv'], truncated: false },
      { mediaId: 3, paths: ['/movies/Movie/unowned.mkv'], truncated: false },
    ],
    arrTargets: [target(['selected.mkv']), retainedOwner],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'resolved');
  assertEquals(plan.arrReassignCandidateMediaIds, [3]);
});

Deno.test('version reassignment can recover every required instance after the source disappeared', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 2, paths: ['/movies/Movie/retained.mkv'], truncated: false },
    ],
    arrTargets: [target([])],
    resolvedCleanup: null,
    cleanupConfigured: false,
    requiredReassignments: new Map([[
      1,
      {
        instanceId: 1,
        instanceType: 'radarr',
        instanceUrl: 'http://radarr',
        configurationUpdatedAt: 1,
        mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
        recordId: 7,
        recordPath: '/movies/Movie',
        episodeId: null,
        managedFileId: 1,
        managedPath: '/movies/Movie/selected.mkv',
        retainedMediaId: 2,
        retainedPath: '/movies/Movie/retained.mkv',
      },
    ]]),
  });

  assertEquals(plan.preview.arrReassignStatus, 'resolved');
  assertEquals(plan.arrReassignCandidateMediaIds, [2]);
});

Deno.test('version reassignment recovery rejects a changed mapped-instance set', async () => {
  const added = target([]);
  added.instanceId = 2;
  added.instanceName = 'New Radarr';
  added.instanceUrl = 'http://radarr-new';
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 2, paths: ['/movies/Movie/retained.mkv'], truncated: false },
    ],
    arrTargets: [target([]), added],
    resolvedCleanup: null,
    cleanupConfigured: false,
    requiredMappingIdentities: [{
      instanceId: 1,
      instanceType: 'radarr',
      instanceUrl: 'http://radarr',
      configurationUpdatedAt: 1,
      mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
    }],
    requiredReassignments: new Map([[
      1,
      {
        instanceId: 1,
        instanceType: 'radarr',
        instanceUrl: 'http://radarr',
        configurationUpdatedAt: 1,
        mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
        recordId: 7,
        recordPath: '/movies/Movie',
        episodeId: null,
        managedFileId: 1,
        managedPath: '/movies/Movie/selected.mkv',
        retainedMediaId: 2,
        retainedPath: '/movies/Movie/retained.mkv',
      },
    ]]),
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'instance set changed');
});

Deno.test('version reassignment recovery rejects new ownership on an unchanged mapped instance', async () => {
  const primary = target(['selected.mkv']);
  const secondary = target([]);
  secondary.instanceId = 2;
  secondary.instanceName = 'Second Radarr';
  secondary.instanceUrl = 'http://radarr-second';
  const initial = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/retained.mkv'], truncated: false },
    ],
    arrTargets: [primary, secondary],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });
  const primaryPlan = initial.eligibleArrReassignments[0]!;
  secondary.client.radarrManagedFile = () =>
    Promise.resolve({
      id: 2,
      relativePath: 'selected.mkv',
      path: '/movies/Movie/selected.mkv',
      size: 100,
    });

  const recovery = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/retained.mkv'], truncated: false },
    ],
    arrTargets: [primary, secondary],
    resolvedCleanup: null,
    cleanupConfigured: false,
    requiredMappingIdentities: initial.arrMappingIdentities,
    requiredOwnerships: new Map(initial.arrOwnerships.map((entry) => [entry.instanceId, entry])),
    requiredReassignments: new Map([[
      primary.instanceId,
      {
        instanceId: primary.instanceId,
        instanceType: primary.instanceType,
        instanceUrl: primary.instanceUrl,
        configurationUpdatedAt: primary.configurationUpdatedAt,
        mappingIdentity: primary.mappingIdentity,
        recordId: primaryPlan.recordId,
        recordPath: primaryPlan.recordPath,
        episodeId: primaryPlan.episodeId,
        managedFileId: primaryPlan.managedFileId!,
        managedPath: primaryPlan.managedPath!,
        retainedMediaId: 2,
        retainedPath: primaryPlan.candidatePaths.get(2)!,
      },
    ]]),
  });

  assertEquals(recovery.preview.arrReassignStatus, 'unavailable');
  assertStringIncludes(recovery.preview.arrReassignReason ?? '', 'changed its managed ownership');
});

Deno.test('version reassignment rejects a required instance that changed managed versions', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 2, paths: ['/movies/Movie/retained.mkv'], truncated: false },
      { mediaId: 3, paths: ['/movies/Movie/other.mkv'], truncated: false },
    ],
    arrTargets: [target(['other.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
    requiredReassignments: new Map([[
      1,
      {
        instanceId: 1,
        instanceType: 'radarr',
        instanceUrl: 'http://radarr',
        configurationUpdatedAt: 1,
        mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
        recordId: 7,
        recordPath: '/movies/Movie',
        episodeId: null,
        managedFileId: 1,
        managedPath: '/movies/Movie/selected.mkv',
        retainedMediaId: 2,
        retainedPath: '/movies/Movie/retained.mkv',
      },
    ]]),
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'changed');
});

Deno.test('version reassignment rejects a replacement Radarr record after interruption', async () => {
  const replacement = target([]);
  replacement.client.lookup = () =>
    Promise.resolve({ id: 99, title: 'Movie', path: '/movies/New', seasons: null });
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 2, paths: ['/movies/Movie/retained.mkv'], truncated: false },
    ],
    arrTargets: [replacement],
    resolvedCleanup: null,
    cleanupConfigured: false,
    requiredReassignments: new Map([[
      1,
      {
        instanceId: 1,
        instanceType: 'radarr',
        instanceUrl: 'http://radarr',
        configurationUpdatedAt: 1,
        mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
        recordId: 7,
        recordPath: '/movies/Movie',
        episodeId: null,
        managedFileId: 1,
        managedPath: '/movies/Movie/selected.mkv',
        retainedMediaId: 2,
        retainedPath: '/movies/Movie/retained.mkv',
      },
    ]]),
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'different managed record');
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

Deno.test('episode plan can reassign Sonarr only within the managed series tree', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'episode',
    item: { ...item, type: 'show', tmdbId: null, tvdbId: 20 },
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/tv/Show/Season 01/old.mkv'], truncated: false },
      { mediaId: 2, paths: ['/tv/Show/Season 01/better.mkv'], truncated: false },
      { mediaId: 3, paths: ['/tv-4k/Show/Season 01/other.mkv'], truncated: false },
    ],
    arrTargets: [sonarrTarget()],
    resolvedCleanup: null,
    cleanupConfigured: false,
    episodeIdentity: { seasonNumber: 1, episodeNumber: 1 },
  });

  assertEquals(plan.preview.arrStatus, 'unavailable');
  assertEquals(plan.preview.arrReassignStatus, 'resolved');
  assertEquals(plan.arrManagedMediaIds, [1]);
  assertEquals(plan.arrReassignCandidateMediaIds, [2]);
});

Deno.test('Sonarr reassignment does not adopt a version managed by another instance', async () => {
  const retainedOwner = sonarrTarget();
  retainedOwner.instanceId = 3;
  retainedOwner.instanceName = 'Sonarr HD';
  retainedOwner.instanceUrl = 'http://sonarr-hd';
  retainedOwner.client.episodeManagedFile = () =>
    Promise.resolve({
      episodeId: 9,
      shared: false,
      file: {
        id: 11,
        relativePath: 'Season 01/better.mkv',
        path: '/tv/Show/Season 01/better.mkv',
        size: 100,
      },
    });
  const plan = await buildVersionDeletionPlan({
    mediaType: 'episode',
    item: { ...item, type: 'show', tmdbId: null, tvdbId: 20 },
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/tv/Show/Season 01/old.mkv'], truncated: false },
      { mediaId: 2, paths: ['/tv/Show/Season 01/better.mkv'], truncated: false },
    ],
    arrTargets: [sonarrTarget(), retainedOwner],
    resolvedCleanup: null,
    cleanupConfigured: false,
    episodeIdentity: { seasonNumber: 1, episodeNumber: 1 },
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertEquals(plan.arrReassignCandidateMediaIds, []);
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'another mapped Arr instance');
});

Deno.test('episode reassignment rejects a replacement Sonarr episode after interruption', async () => {
  const replacement = sonarrTarget();
  replacement.client.episodeManagedFile = () =>
    Promise.resolve({
      episodeId: 99,
      file: null,
    });
  const plan = await buildVersionDeletionPlan({
    mediaType: 'episode',
    item: { ...item, type: 'show', tmdbId: null, tvdbId: 20 },
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 2, paths: ['/tv/Show/Season 01/better.mkv'], truncated: false },
    ],
    arrTargets: [replacement],
    resolvedCleanup: null,
    cleanupConfigured: false,
    episodeIdentity: { seasonNumber: 1, episodeNumber: 1 },
    requiredReassignments: new Map([[
      2,
      {
        instanceId: 2,
        instanceType: 'sonarr',
        instanceUrl: 'http://sonarr',
        configurationUpdatedAt: 1,
        mappingIdentity: '{"addImportExclusion":false,"pathMappings":[]}',
        recordId: 8,
        recordPath: '/tv/Show',
        episodeId: 9,
        managedFileId: 10,
        managedPath: '/tv/Show/Season 01/old.mkv',
        retainedMediaId: 2,
        retainedPath: '/tv/Show/Season 01/better.mkv',
      },
    ]]),
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'different managed episode');
});
