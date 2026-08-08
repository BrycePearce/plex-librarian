import { assertEquals, assertStringIncludes } from '@std/assert';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import { buildVersionDeletionPlan, selectVersionDownloadCleanup } from './versionPlanning.ts';
Deno.test('version cleanup excludes download mutations associated with the retained path', () => {
  const selectedJob = {
    instanceKey: 'qb:1',
    jobId: 'selected',
    authorizedSourcePaths: ['/downloads/selected.mkv'],
  };
  const retainedJob = {
    instanceKey: 'qb:1',
    jobId: 'retained',
    authorizedSourcePaths: ['/downloads/retained.mkv'],
  };
  const cleanup = {
    ratingKey: 'movie',
    status: 'resolved' as const,
    downloadJobs: [selectedJob, retainedJob],
    orphanFiles: [
      { path: '/downloads/selected.mkv', importedPath: '/library/selected.mkv' },
      { path: '/downloads/retained.mkv', importedPath: '/library/retained.mkv' },
    ],
    sources: [
      { downloadId: 'selected', importedPath: '/library/selected.mkv' },
      { downloadId: 'retained', importedPath: '/library/retained.mkv' },
    ],
  } as unknown as Parameters<typeof selectVersionDownloadCleanup>[0];

  const selected = selectVersionDownloadCleanup(
    cleanup,
    new Set(['/library/selected.mkv']),
  );

  assertEquals(selected?.downloadJobs.map((job) => job.jobId), ['selected']);
  assertEquals(selected?.orphanFiles.map((file) => file.path), ['/downloads/selected.mkv']);
});

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
      radarrMovie: () => Promise.resolve({ id: 7, path: '/movies/Movie' }),
      fileVisibility: () => Promise.resolve('file'),
      radarrMovieMonitorTarget: () => Promise.resolve({ id: 7, monitored: true }),
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
      sonarrEpisodeMonitorTarget: () => Promise.resolve({ id: 9, monitored: true }),
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
      {
        mediaId: 2,
        paths: ['/movies/Movie/kept.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
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

Deno.test('version plan keeps Radarr reassignment inside the exact current movie folder', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      {
        mediaId: 2,
        paths: ['/movies/Movie/1080p.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
      {
        mediaId: 3,
        paths: ['/movies-4k/Movie/2160p.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
    ],
    arrTargets: [target(['selected.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'resolved');
  assertEquals(plan.arrManagedMediaIds, [1]);
  assertEquals(plan.arrReassignCandidateMediaIds, [2]);
  assertEquals(
    [...plan.eligibleArrReassignments[0]!.candidateRecordPaths],
    [[2, '/movies/Movie']],
  );
});

Deno.test('version reassignment fails closed with multiple eligible Arr owners', async () => {
  const primary = target(['selected.mkv']);
  const secondary = target(['selected.mkv']);
  secondary.instanceId = 2;
  secondary.instanceName = 'Second Radarr';
  secondary.instanceUrl = 'http://radarr-2';
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      {
        mediaId: 2,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
    ],
    arrTargets: [primary, secondary],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'multiple eligible Arr owners');
});

Deno.test('version plan fails closed for a retained Radarr parent mismatch', async () => {
  const radarr = target(['selected.mkv']);
  radarr.client.fileVisibility = (path: string) =>
    Promise.resolve(path === '/movies/retained.mkv' ? 'file' : 'folder');
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      {
        mediaId: 2,
        paths: ['/movies/retained.mkv'],
        truncated: false,
        fileSize: 50_000,
        projectedFileSize: 50,
      },
    ],
    arrTargets: [radarr],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertEquals('relocationCandidate' in plan, false);
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'exact current movie folder');
});

Deno.test('outside-folder Radarr reassignment remains unavailable for incomplete size evidence', async () => {
  for (const fileSize of [null, 0] as const) {
    const radarr = target(['selected.mkv']);
    radarr.client.fileVisibility = (path: string) =>
      Promise.resolve(path === '/movies/retained.mkv' ? 'file' : 'folder');
    const plan = await buildVersionDeletionPlan({
      mediaType: 'movie',
      item,
      selectedMediaIds: new Set([1]),
      liveVersions: [
        { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
        {
          mediaId: 2,
          paths: ['/movies/retained.mkv'],
          truncated: false,
          fileSize,
          projectedFileSize: 50,
        },
      ],
      arrTargets: [radarr],
      resolvedCleanup: null,
      cleanupConfigured: false,
    });

    assertEquals('relocationCandidate' in plan, false);
  }
});

Deno.test('outside-folder Radarr reassignment fails closed with another unsafe survivor', async () => {
  for (
    const unsafe of [
      { fileSize: null, visible: true },
      { fileSize: 40_000, visible: false },
    ] as const
  ) {
    const radarr = target(['selected.mkv']);
    radarr.client.fileVisibility = (path: string) =>
      Promise.resolve(
        path === '/movies/retained.mkv' ||
          (path === '/movies/other.mkv' && unsafe.visible)
          ? 'file'
          : 'folder',
      );
    const plan = await buildVersionDeletionPlan({
      mediaType: 'movie',
      item,
      selectedMediaIds: new Set([1]),
      liveVersions: [
        { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
        {
          mediaId: 2,
          paths: ['/movies/retained.mkv'],
          truncated: false,
          fileSize: 50_000,
          projectedFileSize: 50,
        },
        {
          mediaId: 3,
          paths: ['/movies/other.mkv'],
          truncated: false,
          fileSize: unsafe.fileSize,
          projectedFileSize: 40,
        },
      ],
      arrTargets: [radarr],
      resolvedCleanup: null,
      cleanupConfigured: false,
    });

    assertEquals('relocationCandidate' in plan, false);
  }
});

Deno.test('outside-folder Radarr reassignment stays unavailable through mapped namespaces', async () => {
  const radarr = target(['selected.mkv']);
  radarr.pathMappings = [{ kind: 'library', arrPath: '/movies', localPath: '/media' }];
  radarr.mappingIdentity = JSON.stringify({
    addImportExclusion: true,
    pathMappings: radarr.pathMappings,
  });
  radarr.client.fileVisibility = (path: string) =>
    Promise.resolve(path === '/movies/retained.mkv' ? 'file' : 'folder');
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/media/Movie/selected.mkv'], truncated: false },
      {
        mediaId: 2,
        paths: ['/media/retained.mkv'],
        truncated: false,
        fileSize: 50_000,
        projectedFileSize: 50,
      },
    ],
    arrTargets: [radarr],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals('relocationCandidate' in plan, false);
  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
});

Deno.test('outside-folder Radarr reassignment rejects an uncovered third path namespace', async () => {
  const radarr = target(['selected.mkv']);
  radarr.pathMappings = [{ kind: 'library', arrPath: '/movies', localPath: '/media' }];
  radarr.mappingIdentity = JSON.stringify({
    addImportExclusion: true,
    pathMappings: radarr.pathMappings,
  });
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/plex/Movie/selected.mkv'], truncated: false },
      {
        mediaId: 2,
        paths: ['/plex/retained.mkv'],
        truncated: false,
        fileSize: 50_000,
        projectedFileSize: 50,
      },
    ],
    arrTargets: [radarr],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals('relocationCandidate' in plan, false);
  assertStringIncludes(
    plan.preview.arrReassignReason ?? '',
    'could not resolve every known Plex version path safely',
  );
});

Deno.test('outside-folder Radarr reassignment remains unavailable with a destination collision', async () => {
  const radarr = target(['selected.mkv']);
  radarr.client.fileVisibility = (path: string) =>
    Promise.resolve(path === '/movies/retained.mkv' ? 'file' : 'folder');
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1, 3]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      {
        mediaId: 2,
        paths: ['/movies/retained.mkv'],
        truncated: false,
        fileSize: 50_000,
        projectedFileSize: 50,
      },
      {
        mediaId: 3,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        fileSize: 50_000,
        projectedFileSize: 50,
      },
    ],
    arrTargets: [radarr],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals('relocationCandidate' in plan, false);
});

Deno.test('Radarr reassignment blocks flat-root, invisible, and unknown-size retained files', async () => {
  for (
    const [retainedPath, projectedFileSize, visibility] of [
      ['/movies/retained.mkv', 50, 'file'],
      ['/movies/Movie/retained.mkv', 50, 'folder'],
      ['/movies/Movie/retained.mkv', null, 'file'],
    ] as const
  ) {
    const radarr = target(['selected.mkv']);
    radarr.client.fileVisibility = () => Promise.resolve(visibility);
    const plan = await buildVersionDeletionPlan({
      mediaType: 'movie',
      item,
      selectedMediaIds: new Set([1]),
      liveVersions: [
        { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
        {
          mediaId: 2,
          paths: [retainedPath],
          truncated: false,
          projectedFileSize,
        },
      ],
      arrTargets: [radarr],
      resolvedCleanup: null,
      cleanupConfigured: false,
    });
    assertEquals(plan.preview.arrReassignStatus, 'unavailable', retainedPath);
  }
});

Deno.test('Radarr reassignment blocks selected-file extras but permits null ownership', async () => {
  for (const [movieFileId, expected] of [[1, 'unavailable'], [null, 'resolved']] as const) {
    const radarr = target(['selected.mkv']);
    radarr.client.extraFiles = () =>
      Promise.resolve([{
        relativePath: 'movie.nfo',
        type: 'metadata',
        movieFileId,
      }]);
    const plan = await buildVersionDeletionPlan({
      mediaType: 'movie',
      item,
      selectedMediaIds: new Set([1]),
      liveVersions: [
        { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
        {
          mediaId: 2,
          paths: ['/movies/Movie/retained.mkv'],
          truncated: false,
          projectedFileSize: 50,
        },
      ],
      arrTargets: [radarr],
      resolvedCleanup: null,
      cleanupConfigured: false,
    });
    assertEquals(plan.preview.arrReassignStatus, expected);
  }
});

Deno.test('version planning reuses one targeted Radarr extra-file read', async () => {
  const radarr = target(['selected.mkv']);
  let extraReads = 0;
  radarr.client.extraFiles = () => {
    extraReads++;
    return Promise.resolve([]);
  };
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      {
        mediaId: 2,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 50,
      },
    ],
    arrTargets: [radarr],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });
  assertEquals(plan.preview.arrReassignStatus, 'resolved');
  assertEquals(extraReads, 1);
});

Deno.test('Radarr reassignment conservatively blocks POSIX paths differing only by case', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/Copy.mkv'], truncated: false },
      {
        mediaId: 2,
        paths: ['/movies/Movie/copy.mkv'],
        truncated: false,
        projectedFileSize: 50,
      },
    ],
    arrTargets: [target(['Copy.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });
  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'differ only by case');
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
  mappedTarget.client.radarrMovie = () => Promise.resolve({ id: 7, path: 'D:\\Movies\\Movie' });
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
        projectedFileSize: 200,
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
  assertStringIncludes(plan.arrOwnershipReason ?? '', 'resolve every known Plex version path');
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

Deno.test('version reassignment blocks another selected version still competing in the folder', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    excludedReassignMediaIds: new Set([1, 2]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      { mediaId: 2, paths: ['/movies/Movie/also-deleting.mkv'], truncated: false },
      {
        mediaId: 3,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
    ],
    arrTargets: [target(['selected.mkv'])],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertEquals(plan.arrReassignCandidateMediaIds, []);
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
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'differ only by case');
});

Deno.test('Radarr removal fallback rejects selected and retained media sharing one path', async () => {
  const radarr = target(['shared.mkv']);
  radarr.client.lookup = () =>
    Promise.resolve({
      id: 7,
      title: 'Movie',
      path: '/movies/Movie',
      seasons: null,
      tmdbId: 10,
      year: 2000,
      monitored: true,
    });
  radarr.client.radarrMovieActivity = () => Promise.resolve({ quiet: true, blocking: [] });
  radarr.client.radarrImportExclusions = () => Promise.resolve([]);
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/shared.mkv'], truncated: false },
      {
        mediaId: 2,
        paths: ['\\movies\\Movie\\shared.mkv'],
        truncated: false,
        projectedFileSize: 100,
      },
    ],
    arrTargets: [radarr],
    resolvedCleanup: null,
    cleanupConfigured: false,
    serverId: 1,
    plexClient: {
      identity: () => Promise.resolve('plex-machine'),
      libraryLocations: () =>
        Promise.resolve({ libraryKey: 'movies', locations: [{ id: 1, path: '/movies' }] }),
    },
    versionRanks: [{
      mediaId: 2,
      videoResolution: null,
      height: null,
      bitrate: null,
      fileSize: 100,
    }],
  });

  assertEquals(plan.preview.radarrPathAdoption.mode, 'unavailable');
  assertEquals(plan.radarrRemovalFallback, undefined);
});

Deno.test('Radarr removal fallback durably binds the exact retained Plex size', async () => {
  const radarr = target(['selected.mkv']);
  radarr.client.lookup = () =>
    Promise.resolve({
      id: 7,
      title: 'Movie',
      path: '/movies/Movie',
      seasons: null,
      tmdbId: 10,
      year: 2000,
      monitored: true,
    });
  radarr.client.radarrMovieActivity = () => Promise.resolve({ quiet: true, blocking: [] });
  radarr.client.radarrImportExclusions = () => Promise.resolve([]);
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      { mediaId: 1, paths: ['/movies/Movie/selected.mkv'], truncated: false },
      {
        mediaId: 2,
        paths: ['/downloads/Movie/retained.mkv'],
        truncated: false,
        fileSize: 123_456,
        projectedFileSize: 121,
      },
    ],
    arrTargets: [radarr],
    resolvedCleanup: null,
    cleanupConfigured: false,
    serverId: 1,
    plexClient: {
      identity: () => Promise.resolve('plex-machine'),
      libraryLocations: () =>
        Promise.resolve({ libraryKey: 'movies', locations: [{ id: 1, path: '/movies' }] }),
    },
    versionRanks: [{
      mediaId: 2,
      videoResolution: null,
      height: null,
      bitrate: null,
      fileSize: 121,
    }],
  });

  assertEquals(plan.preview.radarrPathAdoption.mode, 'remove_from_radarr');
  assertEquals(plan.radarrRemovalFallback?.retainedFileSize, 123_456);
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
      {
        mediaId: 2,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
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
      {
        mediaId: 2,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
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
      {
        mediaId: 2,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
    ],
    arrTargets: [target(['selected.mkv']), retainedOwner],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertEquals(plan.arrReassignCandidateMediaIds, []);
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'another mapped Arr instance');
});

Deno.test('Radarr reassignment rejects an unowned copy beside another managed competitor', async () => {
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
      {
        mediaId: 2,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
      {
        mediaId: 3,
        paths: ['/movies/Movie/unowned.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
    ],
    arrTargets: [target(['selected.mkv']), retainedOwner],
    resolvedCleanup: null,
    cleanupConfigured: false,
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertEquals(plan.arrReassignCandidateMediaIds, []);
});

Deno.test('version reassignment can recover every required instance after the source disappeared', async () => {
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      {
        mediaId: 2,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
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
        originalMonitored: true,
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
        originalMonitored: true,
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
      {
        mediaId: 2,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
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
      {
        mediaId: 2,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
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
        originalMonitored: true,
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
        originalMonitored: true,
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
  replacement.client.radarrMovie = () => Promise.resolve({ id: 99, path: '/movies/New' });
  const plan = await buildVersionDeletionPlan({
    mediaType: 'movie',
    item,
    selectedMediaIds: new Set([1]),
    liveVersions: [
      {
        mediaId: 2,
        paths: ['/movies/Movie/retained.mkv'],
        truncated: false,
        projectedFileSize: 1,
      },
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
        originalMonitored: true,
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
      {
        mediaId: 2,
        paths: ['/tv/Show/Season 01/better.mkv'],
        truncated: false,
        fileSize: 100,
      },
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
  assertEquals('relocationCandidate' in plan, false);
});

Deno.test('episode reassignment requires exact retained Plex size evidence', async () => {
  for (const fileSize of [undefined, null, 0] as const) {
    const plan = await buildVersionDeletionPlan({
      mediaType: 'episode',
      item: { ...item, type: 'show', tmdbId: null, tvdbId: 20 },
      selectedMediaIds: new Set([1]),
      liveVersions: [
        { mediaId: 1, paths: ['/tv/Show/Season 01/old.mkv'], truncated: false },
        {
          mediaId: 2,
          paths: ['/tv/Show/Season 01/better.mkv'],
          truncated: false,
          ...(fileSize === undefined ? {} : { fileSize }),
        },
      ],
      arrTargets: [sonarrTarget()],
      resolvedCleanup: null,
      cleanupConfigured: false,
      episodeIdentity: { seasonNumber: 1, episodeNumber: 1 },
    });

    assertEquals(plan.preview.arrReassignStatus, 'unavailable');
    assertStringIncludes(plan.preview.arrReassignReason ?? '', 'known positive size');
  }
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
      {
        mediaId: 2,
        paths: ['/tv/Show/Season 01/better.mkv'],
        truncated: false,
        fileSize: 100,
      },
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
      {
        mediaId: 2,
        paths: ['/tv/Show/Season 01/better.mkv'],
        truncated: false,
        fileSize: 100,
      },
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
        retainedFileSize: 100,
        originalMonitored: true,
      },
    ]]),
  });

  assertEquals(plan.preview.arrReassignStatus, 'unavailable');
  assertStringIncludes(plan.preview.arrReassignReason ?? '', 'different managed episode');
});
