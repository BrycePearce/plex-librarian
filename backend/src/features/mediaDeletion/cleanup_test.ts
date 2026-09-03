import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '@std/assert';
import { ArrClient } from '../../integrations/arr/client.ts';
import { QbittorrentDownloadClient } from '../../integrations/qbittorrent/adapter.ts';
import { QbittorrentClient } from '../../integrations/qbittorrent/client.ts';
import {
  assertAcceptedWholeShowHashCleanup,
  bindSonarrPathOwnership,
  cleanupAuthorizationFingerprint,
  cleanupHasDurableAcceptedIdentity,
  cleanupIsEligible,
  confirmedAttemptedDownloadJobAbsences,
  DownloadedFileCleanupError,
  executeDownloadedFileCleanup,
  mergeAcceptedSonarrCleanup,
  persistResolvedCleanup,
  persistResolvedCleanupIdentity,
  publicCleanupItem,
  reconcileSharedDownloadCleanups,
  rehydrateResolvedCleanup,
  type ResolvedCleanupItem,
  resolveDownloadCleanup,
  scopeSonarrReclamation,
  selectDirectOrphanFiles,
  selectVerifiedDownloadCleanups,
} from './cleanup.ts';
import { downloadJobOwnsPath, downloadPayloadIsExclusivelyOwned } from './ownership.ts';
import { assertDownloadJobSelectionConsistent } from './planning.ts';

const hash = 'a'.repeat(40);

Deno.test('Sonarr reclamation scope excludes unrelated series evidence', () => {
  const makeProof = (managedFileId: number, name: string) => ({
    hash,
    path: `/downloads/${name}.mkv`,
    importedPath: `/library/show/${name}.mkv`,
    importedRoot: '/library',
    root: '/downloads',
    boundary: '/downloads',
    remotePath: `/remote/${name}.mkv`,
    size: 100,
    method: 'hardlink' as const,
    dev: 1,
    ino: managedFileId,
    nlink: 2,
    rootDevice: '1',
    rootInode: '10',
    importedRootDevice: '1',
    importedRootInode: '11',
    managedFileId,
    managedFileSize: 100,
    managedPath: `/sonarr/show/${name}.mkv`,
    strictTwoLinkProof: true as const,
  });
  const selected = makeProof(1, 'selected');
  const unrelated = makeProof(2, 'unrelated');
  const cleanup = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [{
      instanceName: 'Sonarr',
      type: 'sonarr',
      title: 'Show',
      path: '/tv/Show',
      seasons: [],
      mediaFiles: [],
      extraFiles: [],
    }],
    sources: [selected, unrelated].map((proof) => ({
      instanceName: 'Sonarr',
      downloadId: proof.hash,
      path: proof.remotePath,
      importedPath: proof.managedPath,
      localPath: proof.path,
      verification: 'hardlink' as const,
    })),
    orphanFiles: [selected, unrelated],
    retainedPaths: [selected, unrelated].map((proof) => ({
      path: proof.path,
      reason: 'retained',
    })),
    sonarrReclamation: {
      inventory: [selected, unrelated].map((proof) => ({
        id: proof.managedFileId,
        path: proof.managedPath,
        size: proof.managedFileSize,
      })),
      proofs: [selected, unrelated],
    },
  } as unknown as ResolvedCleanupItem;

  const scoped = scopeSonarrReclamation(cleanup, new Set([1]));
  assertEquals(scoped.sonarrReclamation?.proofs.map((proof) => proof.managedFileId), [1]);
  assertEquals(scoped.sonarrReclamation?.accountingManagedFileIds, [1]);
  assertEquals(scoped.orphanFiles.map((file) => file.path), [selected.path]);
  assertEquals(scoped.retainedPaths.map((entry) => entry.path), [selected.path]);
  assertEquals(scoped.sources.map((source) => source.localPath), [selected.path]);

  const empty = scopeSonarrReclamation(cleanup, new Set([99]));
  assertEquals(empty.sonarrReclamation, undefined);
  assertEquals(empty.orphanFiles, []);
  assertEquals(empty.retainedPaths, []);
  assertEquals(empty.sources, []);
});

Deno.test('empty Sonarr proof sets remain preview-only instead of becoming durable cleanup', async () => {
  const cleanup = {
    ratingKey: 'show',
    status: 'unavailable',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [],
    sources: [],
    orphanFiles: [],
    retainedPaths: [],
    sonarrReclamation: {
      instanceId: 1,
      instanceName: 'Sonarr',
      instanceUrl: 'http://sonarr',
      configurationUpdatedAt: 1,
      mappingIdentity: 'mapping',
      seriesId: 1,
      tvdbId: 1,
      inventory: [{ id: 1, path: '/tv/show/episode.mkv', size: 10 }],
      inventoryIdentity: 'a'.repeat(64),
      proofs: [],
    },
  } satisfies ResolvedCleanupItem;

  const bound = await bindSonarrPathOwnership(cleanup, [], false);

  assertEquals(bound.status, 'resolved');
  assertEquals(bound.sonarrReclamation, undefined);
  assertEquals(cleanupHasDurableAcceptedIdentity(bound), false);
});

Deno.test('public cleanup projection strips durable Sonarr proof evidence', () => {
  const projected = publicCleanupItem({
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [{
      instanceName: 'Sonarr',
      type: 'sonarr',
      title: 'Show',
      path: '/tv/Show',
      seasons: [],
      mediaFiles: [{
        id: 10,
        path: '/tv/Show/episode.mkv',
        relativePath: 'episode.mkv',
        size: 1_000,
      }],
      extraFiles: [],
    }],
    sources: [],
    orphanFiles: [{
      path: '/downloads/episode.mkv',
      size: 1_000,
      method: 'hardlink',
      hash,
      importedPath: '/library/Show/episode.mkv',
      importedRoot: '/library',
      root: '/downloads',
      boundary: '/downloads/release',
      remotePath: '/tv/Show/episode.mkv',
      dev: 1,
      ino: 2,
      nlink: 2,
      rootDevice: '1',
      rootInode: '3',
      importedRootDevice: '1',
      importedRootInode: '4',
      managedFileId: 10,
      managedFileSize: 1_000,
      managedPath: '/tv/Show/episode.mkv',
      strictTwoLinkProof: true,
    }],
    retainedPaths: [],
  } as unknown as ResolvedCleanupItem);

  assertEquals(projected.arrTargets[0]?.mediaFiles, [{
    relativePath: 'episode.mkv',
    size: 1_000,
  }]);
  assertEquals(projected.orphanFiles, [{
    path: '/downloads/episode.mkv',
    size: 1_000,
    method: 'hardlink',
  }]);
});

Deno.test('public Sonarr history exposes an unavailable exact candidate and reason', () => {
  const projected = publicCleanupItem({
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [{
      instanceName: 'Sonarr',
      type: 'sonarr',
      title: 'Show',
      path: '/tv/Show',
      seasons: [],
      mediaFiles: [],
      extraFiles: [],
    }],
    sources: [{
      instanceName: 'Sonarr',
      downloadId: hash,
      path: '/remote/release/episode.mkv',
      importedPath: '/tv/Show/episode.mkv',
      localPath: '/downloads/release/episode.mkv',
      verification: 'unverified',
      reason: 'Source is not the same hardlinked file as the managed file',
    }],
    orphanFiles: [],
    retainedPaths: [],
  });

  assertEquals(projected.sonarrHistoricalPaths, [{
    path: '/downloads/release/episode.mkv',
    managedPath: '/tv/Show/episode.mkv',
    size: null,
    disposition: 'unverified',
    reason: 'Sonarr: Source is not the same hardlinked file as the managed file',
  }]);
});

Deno.test('Sonarr scope retains only unavailable candidates for authorized managed paths', () => {
  const cleanup = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [{
      instanceName: 'Sonarr',
      type: 'sonarr' as const,
      title: 'Show',
      path: '/tv/Show',
      seasons: [],
      mediaFiles: [],
      extraFiles: [],
    }],
    sources: [
      {
        instanceName: 'Sonarr',
        downloadId: hash,
        path: '/remote/selected.mkv',
        importedPath: '/tv/Show/selected.mkv',
        localPath: '/downloads/selected.mkv',
        verification: 'unverified' as const,
        reason: 'selected failure',
      },
      {
        instanceName: 'Sonarr',
        downloadId: hash,
        path: '/remote/other.mkv',
        importedPath: '/tv/Show/other.mkv',
        localPath: '/downloads/other.mkv',
        verification: 'unverified' as const,
        reason: 'unrelated failure',
      },
    ],
    orphanFiles: [],
    retainedPaths: [],
  } satisfies ResolvedCleanupItem;

  const scoped = scopeSonarrReclamation(
    cleanup,
    new Set(),
    new Set(['/tv/Show/selected.mkv']),
  );
  assertEquals(scoped.sources.map((source) => source.localPath), ['/downloads/selected.mkv']);
  assertEquals(publicCleanupItem(scoped).sonarrHistoricalPaths?.map((entry) => entry.path), [
    '/downloads/selected.mkv',
  ]);
});

Deno.test('Radarr verification failures are not projected as Sonarr history', () => {
  const projected = publicCleanupItem({
    ratingKey: 'movie',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [{
      instanceName: 'Radarr',
      type: 'radarr',
      title: 'Movie',
      path: '/movies/Movie',
      seasons: null,
      mediaFiles: [],
      extraFiles: [],
    }],
    sources: [{
      instanceName: 'Radarr',
      downloadId: hash,
      path: '/remote/release/movie.mkv',
      importedPath: '/movies/Movie/movie.mkv',
      localPath: '/downloads/release/movie.mkv',
      verification: 'unverified',
      reason: 'No download path mapping covers this path',
    }],
    orphanFiles: [],
    retainedPaths: [],
  });

  assertEquals(projected.sonarrHistoricalPaths, []);
});

Deno.test('only accepted filesystem or direct-manifest cleanup evidence is persisted', () => {
  const job = (provenance: 'arr_history' | 'direct_manifest') => ({ provenance });
  assertEquals(
    cleanupHasDurableAcceptedIdentity(
      {
        downloadJobs: [job('arr_history')],
        sonarrReclamation: undefined,
      } as unknown as Parameters<typeof cleanupHasDurableAcceptedIdentity>[0],
    ),
    false,
  );
  assertEquals(
    cleanupHasDurableAcceptedIdentity(
      {
        downloadJobs: [job('direct_manifest')],
        sonarrReclamation: undefined,
      } as unknown as Parameters<typeof cleanupHasDurableAcceptedIdentity>[0],
    ),
    true,
  );
  assertEquals(
    cleanupHasDurableAcceptedIdentity(
      {
        downloadJobs: [job('arr_history')],
        sonarrReclamation: {},
      } as unknown as Parameters<typeof cleanupHasDurableAcceptedIdentity>[0],
    ),
    true,
  );
  assertEquals(
    cleanupHasDurableAcceptedIdentity(
      {
        downloadJobs: [],
        sonarrReclamation: undefined,
      } as unknown as Parameters<typeof cleanupHasDurableAcceptedIdentity>[0],
    ),
    false,
  );
});

Deno.test('orphan-only cleanup eligibility requires an accepted Sonarr proof', () => {
  const cleanup = {
    status: 'resolved',
    downloadJobs: [],
    orphanFiles: [{ path: '/downloads/episode.mkv' }],
    sonarrReclamation: undefined,
  } as unknown as Parameters<typeof cleanupIsEligible>[0];

  assertEquals(cleanupIsEligible(cleanup), false);
  assertEquals(cleanupIsEligible({ ...cleanup, sonarrReclamation: {} } as typeof cleanup), true);
  assertEquals(
    cleanupIsEligible({ ...cleanup, downloadJobs: [{}] } as typeof cleanup),
    true,
  );
});

Deno.test('persisted cleanup confirms a lost-response download deletion from live absence', async () => {
  const cleanup = {
    downloadJobs: [
      {
        instanceKey: 'qb:1',
        jobId: 'gone',
        target: { client: { findJob: () => Promise.resolve(null) } },
      },
      {
        instanceKey: 'qb:1',
        jobId: 'present',
        target: { client: { findJob: () => Promise.resolve({ id: 'present' }) } },
      },
    ],
  } as unknown as Parameters<typeof confirmedAttemptedDownloadJobAbsences>[0];

  assertEquals(
    await confirmedAttemptedDownloadJobAbsences(
      cleanup,
      new Set(['qb:1:gone', 'qb:1:present']),
    ),
    new Set(['qb:1:gone']),
  );
});

Deno.test('resolved cleanup survives Radarr-removal replay only with the exact client', () => {
  const target = {
    provider: 'qbittorrent',
    instanceKey: 'qbittorrent:7',
    configurationIdentity: 'db:7:100:https://downloads.example',
    instanceId: 7,
    instanceName: 'Downloads',
    client: {
      findJob: () => Promise.resolve(null),
      deleteJob: () => Promise.resolve(),
    },
  };
  const cleanup = {
    ratingKey: 'movie',
    status: 'resolved',
    downloadJobs: [{
      provider: 'qbittorrent',
      instanceKey: 'qbittorrent:7',
      instanceName: 'Downloads',
      jobId: hash,
      name: 'Movie',
      state: 'pausedUP',
      size: 100,
      uploaded: 0,
      completedAt: null,
      ratio: null,
      seedingTime: 0,
      contentPath: '/downloads/movie',
      savePath: '/downloads',
      trackerHost: null,
      fileCount: 1,
      files: [{ path: 'movie/file.mkv', size: 100 }],
      filesTruncated: false,
      manifestFiles: [{ path: 'movie/file.mkv', size: 100 }],
      authorizedSourcePaths: ['/downloads/movie/file.mkv'],
      target,
    }],
    arrStatus: 'resolved',
    arrTargets: [{ instanceName: 'Radarr', type: 'radarr', title: 'Movie' }],
    sources: [
      {
        instanceName: 'Radarr',
        downloadId: hash,
        path: '/downloads/movie/file.mkv',
        importedPath: '/movies/movie.mkv',
        verification: 'hardlink',
      },
      {
        instanceName: 'Radarr duplicate',
        downloadId: hash,
        path: '/downloads/movie/file.mkv',
        importedPath: '/movies/movie.mkv',
        verification: 'hardlink',
      },
      {
        instanceName: 'Radarr',
        downloadId: 'b'.repeat(40),
        path: '/downloads/other/file.mkv',
        importedPath: '/movies/other.mkv',
        verification: 'hardlink',
      },
    ],
    orphanFiles: [],
    retainedPaths: [{ path: '/downloads/retained', reason: 'not selected' }],
  } as unknown as ResolvedCleanupItem;

  const persisted = persistResolvedCleanup(cleanup);
  assert(!Object.hasOwn(persisted.downloadJobs[0]!, 'target'));
  const replayed = rehydrateResolvedCleanup(persisted, [target]);
  assert(replayed.downloadJobs[0]!.target === target);

  const identity = persistResolvedCleanupIdentity(cleanup);
  assertEquals(identity.downloadJobs[0]!.manifestFiles, []);
  assertEquals(identity.sources.length, 1);
  assertEquals(identity.sources[0]!.downloadId, hash);
  assertEquals(identity.sources[0]!.importedPath, '/movies/movie.mkv');
  assertEquals(identity.arrTargets, []);
  assertEquals(identity.retainedPaths, []);
  assertEquals(rehydrateResolvedCleanup(identity, [target]).downloadJobs[0]!.jobId, hash);

  assertThrows(
    () => rehydrateResolvedCleanup(persisted, [{ ...target, instanceName: 'Replacement' }]),
    Error,
    'configured download client changed',
  );
  assertThrows(
    () =>
      rehydrateResolvedCleanup(persisted, [{
        ...target,
        configurationIdentity: 'db:7:101:https://replacement.example',
      }]),
    Error,
    'configured download client changed',
  );
});

Deno.test('whole-item direct cleanup rehydrates with an empty retained-path evidence set', () => {
  const target = {
    provider: 'qbittorrent',
    instanceKey: 'qbittorrent:7',
    configurationIdentity: 'db:7:100:https://downloads.example',
    instanceId: 7,
    instanceName: 'Downloads',
    pathMappings: [],
    client: { findJob: () => Promise.resolve(null), deleteJob: () => Promise.resolve() },
  };
  const cleanup = {
    ratingKey: 'movie',
    status: 'resolved',
    downloadJobs: [{
      provider: target.provider,
      instanceKey: target.instanceKey,
      instanceName: target.instanceName,
      jobId: hash,
      name: 'Movie',
      state: 'pausedUP',
      size: 100,
      uploaded: 0,
      completedAt: null,
      ratio: null,
      seedingTime: 0,
      contentPath: '/downloads/movie.mkv',
      savePath: '/downloads',
      trackerHost: null,
      fileCount: 1,
      files: [{ path: 'movie.mkv', size: 100 }],
      filesTruncated: false,
      manifestFiles: [{ path: 'movie.mkv', size: 100 }],
      authorizedSourcePaths: ['/downloads/movie.mkv'],
      directPathEvidence: [{
        remotePath: '/downloads/movie.mkv',
        localPath: '/downloads/movie.mkv',
        size: 100,
        device: '1',
        inode: '2',
        canonicalPath: '/downloads/movie.mkv',
      }],
      directPlexPathEvidence: [{
        serverId: 1,
        libraryKey: 'movies',
        plexPath: '/movies/movie.mkv',
        localPath: '/downloads/movie.mkv',
        mappingId: 1,
        mappingRevision: 1,
        mappingPlexPath: '/movies',
        mappingLocalPath: '/downloads',
        mappingCaseSensitive: true,
      }],
      directRetainedPathEvidence: [],
      provenance: 'direct_manifest',
      discoverySummaryFingerprint: 'a'.repeat(64),
      ownershipSummaryFingerprint: 'b'.repeat(64),
      manifestFingerprint: 'c'.repeat(64),
      directDiscoveryCandidates: [{ path: '/downloads/movie.mkv', caseSensitive: true }],
      directPathMappings: [],
      target,
    }],
    arrStatus: 'unavailable',
    arrTargets: [],
    sources: [],
    orphanFiles: [],
    retainedPaths: [],
  } as unknown as ResolvedCleanupItem;

  const persisted = persistResolvedCleanupIdentity(cleanup);
  assertEquals(persisted.downloadJobs[0]!.directRetainedPathEvidence, []);
  assertEquals(rehydrateResolvedCleanup(persisted, [target]).downloadJobs.length, 1);
  const publicJob = publicCleanupItem(cleanup).downloadJobs[0]! as unknown as Record<
    string,
    unknown
  >;
  assertEquals(Object.hasOwn(publicJob, 'directPathEvidence'), false);
  assertEquals(Object.hasOwn(publicJob, 'discoverySummaryFingerprint'), false);
});

Deno.test('qBittorrent selection cannot split one associated job across a requested batch', () => {
  const job = { instanceKey: 'qb:1', jobId: hash };
  const cleanups = [
    {
      ratingKey: 'selected',
      downloadJobs: [job],
      observedDownloadJobKeys: new Set(['qb:1:' + hash]),
    },
    {
      ratingKey: 'unselected',
      downloadJobs: [],
      observedDownloadJobKeys: new Set(['qb:1:' + hash]),
    },
  ] as unknown as ResolvedCleanupItem[];
  assertThrows(
    () => assertDownloadJobSelectionConsistent(cleanups, new Set(['selected'])),
    Error,
    'shared by cleanup-selected and cleanup-unselected',
  );
  assertDownloadJobSelectionConsistent(cleanups, new Set(['selected', 'unselected']));
});

Deno.test('accepted Sonarr proof retains only accepted Arr-history jobs and orphan paths', () => {
  const acceptedOrphan = { path: '/downloads/accepted.mkv', hash: 'accepted' };
  const replacementOrphan = { path: '/downloads/replacement.mkv' };
  const accepted = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [{ instanceKey: 'qb:1', jobId: 'old', provenance: 'arr_history' }],
    orphanFiles: [acceptedOrphan],
    sonarrReclamation: { inventoryIdentity: 'accepted' },
  } as unknown as ResolvedCleanupItem;
  const current = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [{ instanceKey: 'qb:1', jobId: 'old', provenance: 'arr_history' }],
    orphanFiles: [replacementOrphan],
    observedDownloadJobKeys: new Set(['qb:1:old']),
  } as unknown as ResolvedCleanupItem;

  const merged = mergeAcceptedSonarrCleanup(current, accepted);
  assertEquals(merged.downloadJobs.map((job) => job.jobId), ['old']);
  assert(merged.orphanFiles[0] === acceptedOrphan);
  assert(merged.sonarrReclamation === accepted.sonarrReclamation);
  assertEquals(merged.observedDownloadJobKeys, new Set(['qb:1:old']));
});

Deno.test('accepted orphan-only Sonarr cleanup suppresses unlink beneath a reappeared job', () => {
  const accepted = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    orphanFiles: [{ path: '/downloads/accepted.mkv', hash: 'reappeared' }],
    sonarrReclamation: { inventoryIdentity: 'accepted' },
  } as unknown as ResolvedCleanupItem;
  const currentJob = {
    instanceKey: 'qb:1',
    jobId: 'reappeared',
    provenance: 'arr_history',
  };
  const current = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [currentJob],
    orphanFiles: [],
    observedDownloadJobKeys: new Set(['qb:1:reappeared']),
  } as unknown as ResolvedCleanupItem;

  const merged = mergeAcceptedSonarrCleanup(current, accepted);
  assertEquals(merged.downloadJobs, []);
  assertEquals(merged.orphanFiles, []);
});

Deno.test('cleanup authorization fingerprints bind the accepted destructive evidence', async () => {
  const cleanup = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [],
    sources: [],
    orphanFiles: [{ path: '/downloads/accepted.mkv' }],
    retainedPaths: [],
    sonarrReclamation: { inventoryIdentity: 'accepted' },
  } as unknown as ResolvedCleanupItem;

  const accepted = await cleanupAuthorizationFingerprint(cleanup);
  const changed = await cleanupAuthorizationFingerprint({
    ...cleanup,
    orphanFiles: [{ path: '/downloads/replacement.mkv' }],
  } as ResolvedCleanupItem);

  assertEquals(accepted.length, 64);
  assert(accepted !== changed);
});

Deno.test('accepted Sonarr cleanup does not replace a failed Arr-history revalidation', () => {
  const accepted = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [{ instanceKey: 'qb:1', jobId: 'old', provenance: 'arr_history' }],
    orphanFiles: [{ path: '/downloads/accepted.mkv' }],
    sonarrReclamation: { inventoryIdentity: 'accepted' },
  } as unknown as ResolvedCleanupItem;
  const current = {
    ratingKey: 'show',
    status: 'error',
    reason: 'Current Sonarr history is unavailable',
    downloadJobs: [],
    orphanFiles: [],
  } as unknown as ResolvedCleanupItem;

  assertThrows(
    () => mergeAcceptedSonarrCleanup(current, accepted),
    Error,
    'Current Sonarr history is unavailable',
  );
});

Deno.test('revalidated Sonarr-only cleanup survives unrelated Arr-history failure', () => {
  const accepted = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    orphanFiles: [],
    retainedPaths: [{
      path: '/downloads/accepted.mkv',
      reason: 'The applicable qBittorrent client could not be inspected',
    }],
    sonarrReclamation: { inventoryIdentity: 'accepted' },
  } as unknown as ResolvedCleanupItem;
  const current = {
    ratingKey: 'show',
    status: 'error',
    reason: 'Current Sonarr history is unavailable',
    downloadJobs: [],
    orphanFiles: [],
  } as unknown as ResolvedCleanupItem;

  const merged = mergeAcceptedSonarrCleanup(current, accepted, true);
  assertEquals(merged.downloadJobs, []);
  assertEquals(merged.orphanFiles, []);
  assertEquals(merged.retainedPaths, accepted.retainedPaths);
  assert(merged.sonarrReclamation === accepted.sonarrReclamation);
});

Deno.test('live torrent ownership requires an exact manifest path, not only the hash', () => {
  const torrent = {
    contentPath: '/downloads/new-release',
    savePath: '/downloads',
    manifestFiles: [{ path: 'new-release/movie.mkv', size: 100 }],
  };
  assertEquals(downloadJobOwnsPath(torrent, '/downloads/new-release/movie.mkv'), true);
  assertEquals(downloadJobOwnsPath(torrent, '/downloads/old-release/movie.mkv'), false);
});

Deno.test('torrent payload deletion requires every manifest file to belong to the title', () => {
  const torrent = {
    contentPath: '/downloads/collection',
    savePath: '/downloads',
    manifestFiles: [
      { path: 'collection/selected.mkv', size: 100 },
      { path: 'collection/other.mkv', size: 100 },
    ],
  };
  assertEquals(
    downloadPayloadIsExclusivelyOwned(torrent, new Set(['/downloads/collection/selected.mkv'])),
    false,
  );
  assertEquals(
    downloadPayloadIsExclusivelyOwned(
      torrent,
      new Set([
        '/downloads/collection/selected.mkv',
        '/downloads/collection/other.mkv',
      ]),
    ),
    true,
  );
});

Deno.test('live torrent ownership supports Windows qBittorrent paths', () => {
  assertEquals(
    downloadJobOwnsPath({
      contentPath: 'D:\\Downloads\\Release',
      savePath: 'D:\\Downloads',
      manifestFiles: [{ path: 'Release\\Movie.mkv', size: 100 }],
    }, 'd:\\downloads\\release\\movie.mkv'),
    true,
  );
});

Deno.test('absolute manifest paths cannot claim ownership outside the torrent roots', () => {
  const torrent = {
    contentPath: '/downloads/unrelated-release',
    savePath: '/downloads',
    manifestFiles: [{ path: '/downloads/historical/movie.mkv', size: 100 }],
  };
  const sourcePaths = new Set(['/downloads/historical/movie.mkv']);
  assertEquals(downloadJobOwnsPath(torrent, '/downloads/historical/movie.mkv'), false);
  assertEquals(downloadPayloadIsExclusivelyOwned(torrent, sourcePaths), false);
});

Deno.test('torrent ownership suppresses only the exact orphan path sharing its hash', () => {
  const current = {
    hash,
    path: '/local/current/movie.mkv',
    remotePath: '/downloads/current/movie.mkv',
  };
  const old = {
    hash,
    path: '/local/old/movie.mkv',
    remotePath: '/downloads/old/movie.mkv',
  };
  const torrent = {
    jobId: hash,
    contentPath: '/downloads/current',
    savePath: '/downloads',
    manifestFiles: [{ path: 'current/movie.mkv', size: 100 }],
  };
  assertEquals(
    selectDirectOrphanFiles(
      [current, old] as unknown as Parameters<typeof selectDirectOrphanFiles>[0],
      [torrent] as unknown as Parameters<typeof selectDirectOrphanFiles>[1],
    ).map((file) => file.path),
    ['/local/old/movie.mkv'],
  );
});

Deno.test('complete downloaded-file execution marks and deletes torrents before orphan files', async () => {
  const calls: string[] = [];
  const cleanup = {
    downloadJobs: [{
      provider: 'qbittorrent',
      instanceKey: 'db:1',
      jobId: hash,
      contentPath: '/downloads/release',
      savePath: '/downloads',
      manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
      authorizedSourcePaths: ['/downloads/release/movie.mkv'],
      target: {
        client: {
          findJob: () =>
            Promise.resolve({
              id: hash,
              contentPath: '/downloads/release',
              savePath: '/downloads',
              manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
            }),
          deleteJob: (value: string) => {
            calls.push(`torrent:${value}`);
            return Promise.resolve();
          },
        },
      },
    }],
    orphanFiles: [{ path: '/downloads/release/movie.idx' }],
  } as unknown as ResolvedCleanupItem;
  const result = await executeDownloadedFileCleanup(
    cleanup,
    new Set(),
    new Set(),
    (_torrent, key) => {
      calls.push(`mark:${key}`);
      return Promise.resolve();
    },
    (file) => {
      calls.push(`orphan:${file.path}`);
      return Promise.resolve();
    },
  );
  assertEquals(calls, [
    `mark:db:1:${hash}`,
    `torrent:${hash}`,
    'orphan:/downloads/release/movie.idx',
  ]);
  assertEquals(result.deletedJobs.map((job) => job.jobId), [hash]);
  assertEquals(result.deletedOrphanFiles, ['/downloads/release/movie.idx']);
});

Deno.test('final Sonarr ownership authorization runs after payload deletion and before unlink', async () => {
  const calls: string[] = [];
  const cleanup = {
    downloadJobs: [{
      provider: 'qbittorrent',
      instanceKey: 'db:1',
      jobId: hash,
      contentPath: '/downloads/release',
      savePath: '/downloads',
      manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
      authorizedSourcePaths: ['/downloads/release/movie.mkv'],
      target: {
        client: {
          findJob: () =>
            Promise.resolve({
              id: hash,
              contentPath: '/downloads/release',
              savePath: '/downloads',
              manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
            }),
          deleteJob: () => {
            calls.push('torrent');
            return Promise.resolve();
          },
        },
      },
    }],
    orphanFiles: [{ path: '/downloads/release/movie.idx' }],
  } as unknown as ResolvedCleanupItem;

  const result = await executeDownloadedFileCleanup(
    cleanup,
    new Set(),
    new Set(),
    undefined,
    (file) => {
      calls.push(`orphan:${file.path}`);
      return Promise.resolve();
    },
    undefined,
    undefined,
    (file) => {
      calls.push(`authorize:${file.path}`);
      return Promise.resolve(false);
    },
  );

  assertEquals(calls, ['torrent', 'authorize:/downloads/release/movie.idx']);
  assertEquals(result.deletedOrphanFiles, []);
});

Deno.test('an already absent attempted orphan reruns its durable confirmation callback', async () => {
  const calls: string[] = [];
  const cleanup = {
    downloadJobs: [],
    orphanFiles: [{ path: '/downloads/release/movie.idx' }],
  } as unknown as ResolvedCleanupItem;

  const result = await executeDownloadedFileCleanup(
    cleanup,
    new Set(),
    new Set(['/downloads/release/movie.idx']),
    undefined,
    () => Promise.reject(new Error('already absent orphan must not be unlinked again')),
    undefined,
    (file) => {
      calls.push(`confirm:${file.path}`);
      return Promise.resolve();
    },
  );

  assertEquals(calls, ['confirm:/downloads/release/movie.idx']);
  assertEquals(result.alreadyRemovedOrphanFiles, ['/downloads/release/movie.idx']);
  assertEquals(result.deletedOrphanFiles, []);
});

Deno.test('a confirmed selected payload absence authorizes its exact orphan without rediscovery', async () => {
  const calls: string[] = [];
  const cleanup = {
    downloadJobs: [],
    orphanFiles: [{
      path: '/downloads/release/movie.idx',
      ownershipJobs: [{
        provider: 'qbittorrent',
        instanceKey: 'db:1',
        jobId: hash,
        selected: true,
      }],
    }],
  } as unknown as ResolvedCleanupItem;

  const result = await executeDownloadedFileCleanup(
    cleanup,
    new Set([`db:1:${hash}`]),
    new Set(),
    undefined,
    () => Promise.reject(new Deno.errors.NotFound('removed with payload')),
    (file) => {
      calls.push(`mark:${file.path}`);
      return Promise.resolve();
    },
    (file) => {
      calls.push(`confirm:${file.path}`);
      return Promise.resolve();
    },
    () => {
      calls.push('authorize');
      return Promise.resolve(false);
    },
  );

  assertEquals(calls, [
    'mark:/downloads/release/movie.idx',
    'confirm:/downloads/release/movie.idx',
  ]);
  assertEquals(result.deletedOrphanFiles, ['/downloads/release/movie.idx']);
});

Deno.test('cleanup errors retain mutations completed by earlier stages', async () => {
  const cleanup = {
    downloadJobs: [{
      provider: 'qbittorrent',
      instanceKey: 'db:1',
      instanceName: 'qBittorrent',
      jobId: hash,
      name: 'release',
      contentPath: '/downloads/release',
      savePath: '/downloads',
      manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
      authorizedSourcePaths: ['/downloads/release/movie.mkv'],
      target: {
        client: {
          findJob: () =>
            Promise.resolve({
              id: hash,
              contentPath: '/downloads/release',
              savePath: '/downloads',
              manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
            }),
          deleteJob: () => Promise.resolve(),
        },
      },
    }],
    orphanFiles: [{ path: '/downloads/release/movie.idx' }],
  } as unknown as ResolvedCleanupItem;

  let caught: unknown;
  try {
    await executeDownloadedFileCleanup(
      cleanup,
      new Set(),
      new Set(),
      undefined,
      () => Promise.reject(new Error('unlink failed')),
    );
  } catch (error) {
    caught = error;
  }

  assertEquals(caught instanceof DownloadedFileCleanupError, true);
  const cleanupError = caught as DownloadedFileCleanupError;
  assertEquals(cleanupError.result.deletedJobs.map((job) => job.jobId), [hash]);
  assertEquals(cleanupError.system, 'filesystem');
  assertEquals(cleanupError.target, '/downloads/release/movie.idx');
});

Deno.test('execution refuses a hash re-added with a different manifest', async () => {
  let deleted = false;
  const cleanup = {
    downloadJobs: [{
      provider: 'qbittorrent',
      instanceKey: 'db:1',
      jobId: hash,
      contentPath: '/downloads/release',
      savePath: '/downloads',
      manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
      authorizedSourcePaths: ['/downloads/release/movie.mkv'],
      target: {
        client: {
          findJob: () =>
            Promise.resolve({
              id: hash,
              contentPath: '/downloads/re-added',
              savePath: '/downloads',
              manifestFiles: [{ path: 're-added/unrelated.mkv', size: 100 }],
            }),
          deleteJob: () => {
            deleted = true;
            return Promise.resolve();
          },
        },
      },
    }],
    orphanFiles: [],
  } as unknown as ResolvedCleanupItem;

  await assertRejects(
    () => executeDownloadedFileCleanup(cleanup, new Set(), new Set()),
    Error,
    'changed since verification',
  );
  assertEquals(deleted, false);
});

Deno.test('direct cleanup refuses a changed candidate job inventory before deletion', async () => {
  let deleted = false;
  let findJobCalled = false;
  let discoveryCandidates: unknown = null;
  const current = {
    id: hash,
    name: 'release',
    state: 'pausedUP',
    size: 100,
    uploaded: 0,
    completedAt: null,
    ratio: null,
    seedingTime: 0,
    contentPath: '/downloads/release/movie.mkv',
    savePath: '/downloads',
    trackerHost: null,
    fileCount: 1,
    files: [{ path: 'release/movie.mkv', size: 100 }],
    filesTruncated: false,
    manifestFiles: [{ path: 'release/movie.mkv', size: 100 }],
  };
  const cleanup = {
    downloadJobs: [{
      ...current,
      provider: 'qbittorrent',
      instanceKey: 'db:1',
      instanceName: 'qBittorrent',
      jobId: hash,
      authorizedSourcePaths: ['/downloads/release/movie.mkv'],
      directPathEvidence: [],
      provenance: 'direct_manifest',
      discoverySummaryFingerprint: 'a'.repeat(64),
      ownershipSummaryFingerprint: 'b'.repeat(64),
      manifestFingerprint: 'c'.repeat(64),
      directDiscoveryCandidates: [{
        path: '/downloads/release/movie.mkv',
        caseSensitive: true,
      }],
      directPathMappings: [],
      target: {
        pathMappings: [],
        client: {
          findJob: () => {
            findJobCalled = true;
            return Promise.resolve(current);
          },
          discoverJobs: (candidates: unknown) => {
            discoveryCandidates = candidates;
            return Promise.resolve({
              jobs: [current],
              summaryFingerprint: 'd'.repeat(64),
            });
          },
          deleteJob: () => {
            deleted = true;
            return Promise.resolve();
          },
        },
      },
    }],
    orphanFiles: [],
  } as unknown as ResolvedCleanupItem;

  await assertRejects(
    () => executeDownloadedFileCleanup(cleanup, new Set(), new Set()),
    DownloadedFileCleanupError,
    'Direct download manifest changed since preview',
  );
  assertEquals(findJobCalled, false);
  assertEquals(discoveryCandidates, [{
    path: '/downloads/release/movie.mkv',
    caseSensitive: true,
  }]);
  assertEquals(deleted, false);
});

function arrTarget(historyMovieIds: number[] = [7]) {
  const client = new ArrClient(
    'radarr',
    'http://radarr',
    'key',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/movie?tmdbId=')) {
        return Promise.resolve(Response.json([{
          id: 7,
          title: 'Movie',
          path: 'A:\\Movies\\Movie',
        }]));
      }
      if (url.includes('/extrafile?movieId=')) {
        return Promise.resolve(Response.json([
          { relativePath: 'Movie.idx', type: 'subtitle', movieFileId: null },
          { relativePath: 'Movie.sub', type: 'subtitle', movieFileId: null },
        ]));
      }
      if (url.includes('/moviefile?movieId=')) {
        return Promise.resolve(Response.json([
          { relativePath: 'Movie.mov', size: 100 },
        ]));
      }
      if (url.includes('/history?')) {
        return Promise.resolve(Response.json({
          totalRecords: historyMovieIds.length,
          records: historyMovieIds.map((movieId) => ({ movieId })),
        }));
      }
      return Promise.resolve(Response.json([{
        eventType: 'downloadFolderImported',
        downloadId: hash,
        data: { droppedPath: '/downloads/release/movie.mkv' },
      }]));
    }) as typeof fetch,
  );
  return {
    instanceId: 1,
    instanceName: 'Radarr',
    instanceType: 'radarr' as const,
    instanceUrl: 'http://radarr',
    configurationUpdatedAt: 1,
    mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
    client,
    addImportExclusion: true,
    pathMappings: [],
  };
}

function qbitTarget(
  loginResponse = new Response('Ok.', {
    headers: { 'Set-Cookie': 'SID=abc; path=/' },
  }),
  release = 'release',
) {
  const client = new QbittorrentClient(
    'http://qbit:8080',
    'user',
    'pass',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/app/version')) {
        return Promise.resolve(new Response('Forbidden', { status: 403 }));
      }
      if (url.endsWith('/auth/login')) return Promise.resolve(loginResponse.clone());
      if (url.includes('/torrents/info')) {
        return Promise.resolve(Response.json([{
          hash,
          name: 'Release',
          size: 100,
          total_size: 100,
          content_path: `/downloads/${release}`,
          save_path: '/downloads',
          tracker: 'https://tracker.example/private-passkey',
        }]));
      }
      return Promise.resolve(
        Response.json([{ index: 0, name: `${release}/movie.mkv`, size: 100 }]),
      );
    }) as typeof fetch,
  );
  return {
    provider: 'qbittorrent',
    instanceKey: 'db:1',
    configurationIdentity: 'db:1:100:https://downloads.example',
    instanceId: 1,
    instanceName: 'qBittorrent',
    client: new QbittorrentDownloadClient(client),
  };
}

function partialShowTargets(options: {
  shared?: boolean;
  historyFailure?: boolean;
  exclusivityFailure?: boolean;
  ownsSource?: boolean;
  radarr?: boolean;
  manifestFiles?: Array<{ path: string; size: number | null }>;
} = {}) {
  const sourcePath = options.ownsSource === false
    ? '/downloads/other/episode-1.mkv'
    : '/downloads/release/episode-1.mkv';
  const manifestFiles = options.manifestFiles ?? [
    { path: 'release/episode-1.mkv', size: 100 },
    { path: 'release/episode-2.mkv', size: 100 },
  ];
  const arr = {
    instanceId: 2,
    instanceName: 'Sonarr',
    instanceType: options.radarr ? 'radarr' as const : 'sonarr' as const,
    instanceUrl: 'http://sonarr',
    configurationUpdatedAt: 10,
    mappingIdentity: 'mapping',
    addImportExclusion: false,
    pathMappings: [],
    client: {
      type: options.radarr ? 'radarr' as const : 'sonarr' as const,
      lookup: () =>
        Promise.resolve({
          id: 42,
          title: 'Dark Angel',
          path: '/tv/Dark Angel',
          seasons: [],
        }),
      mediaFiles: () => Promise.resolve([]),
      extraFiles: () => Promise.resolve([]),
      torrentAssociations: () =>
        options.historyFailure ? Promise.reject(new Error('history failed')) : Promise.resolve([{
          hash,
          sourcePath,
          payloadPath: null,
          importedPath: '/tv/Dark Angel/episode-1.mkv',
          historyId: 1,
          date: null,
        }]),
      sonarrSeriesSnapshot: () => Promise.resolve({ episodes: [], files: [] }),
      downloadIdIsExclusiveTo: () =>
        options.exclusivityFailure
          ? Promise.reject(new Error('exclusivity lookup failed'))
          : Promise.resolve(options.shared !== true),
    },
  } as unknown as Parameters<typeof resolveDownloadCleanup>[2][number];
  const job = {
    id: hash,
    name: 'Dark Angel season pack',
    state: 'uploading',
    size: 200,
    uploaded: 0,
    completedAt: null,
    ratio: 1,
    seedingTime: 10,
    contentPath: '/downloads/release',
    savePath: '/downloads',
    trackerHost: null,
    fileCount: manifestFiles.length,
    files: manifestFiles,
    filesTruncated: false,
    manifestFiles,
  };
  const download = {
    provider: 'qbittorrent',
    instanceKey: 'db:1',
    configurationIdentity: 'db:1:10:http://qbit',
    instanceId: 1,
    instanceName: 'qBittorrent',
    client: {
      findJob: () => Promise.resolve(job),
      deleteJob: () => Promise.resolve(),
    },
  } as Parameters<typeof resolveDownloadCleanup>[3][number];
  return { arr, download, job };
}

Deno.test('whole-show Sonarr hash authority accepts a complete live job with partial history', async () => {
  const { arr, download } = partialShowTargets();
  const result = await resolveDownloadCleanup(
    'show-1',
    { title: 'Dark Angel', type: 'show', tmdbId: null, tvdbId: 76148 },
    [arr],
    [download],
    new Set(),
    [],
    new Set(),
    undefined,
    { allowWholeShowHash: true },
  );
  assertEquals(result.status, 'resolved');
  assertEquals(result.downloadJobs[0]?.authorizationMode, 'whole_show_hash');
  assertEquals(result.downloadJobs[0]?.sonarrAssociations?.[0]?.seriesId, 42);
  assertEquals(result.downloadJobs[0]?.manifestFiles.length, 2);
  assertEquals(publicCleanupItem(result).downloadJobs.length, 1);
  assertEquals(
    Object.hasOwn(publicCleanupItem(result).downloadJobs[0]!, 'authorizationMode'),
    false,
  );
});

Deno.test('default manifest-path authority still rejects partial Sonarr history coverage', async () => {
  const { arr, download } = partialShowTargets();
  const result = await resolveDownloadCleanup(
    'show-1',
    { title: 'Dark Angel', type: 'show', tmdbId: null, tvdbId: 76148 },
    [arr],
    [download],
  );
  assertEquals(result.downloadJobs, []);
  assertStringIncludes(result.reason ?? '', 'not all attributable');
});

Deno.test('whole-show hash authority fails closed on shared, failed, unowned, or malformed evidence', async () => {
  for (
    const options of [
      { shared: true },
      { historyFailure: true },
      { exclusivityFailure: true },
      { ownsSource: false },
      { radarr: true },
    ]
  ) {
    const { arr, download } = partialShowTargets(options);
    const result = await resolveDownloadCleanup(
      'show-1',
      { title: 'Dark Angel', type: 'show', tmdbId: null, tvdbId: 76148 },
      [arr],
      [download],
      new Set(),
      [],
      new Set(),
      undefined,
      { allowWholeShowHash: true },
    );
    assertEquals(result.downloadJobs, [], JSON.stringify(options));
  }
  const malformed = partialShowTargets({
    manifestFiles: [{ path: 'release/episode-1.mkv', size: null }],
  });
  const result = await resolveDownloadCleanup(
    'show-1',
    { title: 'Dark Angel', type: 'show', tmdbId: null, tvdbId: 76148 },
    [malformed.arr],
    [malformed.download],
    new Set(),
    [],
    new Set(),
    undefined,
    { allowWholeShowHash: true },
  );
  assertEquals(result.status, 'error');
  assertEquals(result.downloadJobs, []);
  assertStringIncludes(result.reason ?? '', 'malformed whole-show download evidence');
});

Deno.test('accepted whole-show cleanup rejects replacement or expanded job sets and Sonarr drift', async () => {
  const { arr, download } = partialShowTargets();
  const current = await resolveDownloadCleanup(
    'show-1',
    { title: 'Dark Angel', type: 'show', tmdbId: null, tvdbId: 76148 },
    [arr],
    [download],
    new Set(),
    [],
    new Set(),
    undefined,
    { allowWholeShowHash: true },
  );
  const accepted = {
    ...current,
    downloadJobs: current.downloadJobs.map((job) => ({
      ...job,
      sonarrAssociations: job.sonarrAssociations?.map((association) => ({
        ...association,
        sourcePaths: [...association.sourcePaths],
      })),
    })),
  };
  assertAcceptedWholeShowHashCleanup(current, accepted, new Set());
  assertThrows(
    () =>
      assertAcceptedWholeShowHashCleanup(
        {
          ...current,
          downloadJobs: [...current.downloadJobs, {
            ...current.downloadJobs[0]!,
            jobId: 'b'.repeat(40),
          }],
        },
        accepted,
        new Set(),
      ),
    Error,
    'job set changed',
  );
  const drifted = {
    ...current,
    downloadJobs: current.downloadJobs.map((job) => ({
      ...job,
      sonarrAssociations: job.sonarrAssociations?.map((association) => ({
        ...association,
        sourcePaths: [...association.sourcePaths],
      })),
    })),
  };
  drifted.downloadJobs[0]!.sonarrAssociations![0]!.configurationUpdatedAt++;
  assertThrows(
    () => assertAcceptedWholeShowHashCleanup(drifted, accepted, new Set()),
    Error,
    'Sonarr download association changed',
  );
});

Deno.test('whole-show execution rejects changed qBittorrent summary or manifest fingerprints', async () => {
  const { arr, download, job } = partialShowTargets();
  const cleanup = await resolveDownloadCleanup(
    'show-1',
    { title: 'Dark Angel', type: 'show', tmdbId: null, tvdbId: 76148 },
    [arr],
    [download],
    new Set(),
    [],
    new Set(),
    undefined,
    { allowWholeShowHash: true },
  );
  let deleted = false;
  download.client.findJob = () =>
    Promise.resolve({
      ...job,
      size: job.size + 1,
      manifestFiles: job.manifestFiles.map((file, index) =>
        index === 0 ? { ...file, size: file.size! + 1 } : file
      ),
    });
  download.client.deleteJob = () => {
    deleted = true;
    return Promise.resolve();
  };
  await assertRejects(
    () => executeDownloadedFileCleanup(cleanup, new Set(), new Set()),
    DownloadedFileCleanupError,
    'identity or manifest changed',
  );
  assertEquals(deleted, false);
});

Deno.test('torrent cleanup resolves Arr import history to live redacted qBittorrent details', async () => {
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget()],
  );
  assertEquals(result.status, 'resolved');
  assertEquals(result.downloadJobs[0]?.jobId, hash);
  assertEquals(result.downloadJobs[0]?.sourcePath, '/downloads/release/movie.mkv');
  assertEquals(result.downloadJobs[0]?.trackerHost, 'tracker.example');
  assertEquals(result.arrStatus, 'resolved');
  assertEquals(result.arrTargets, [{
    instanceName: 'Radarr',
    type: 'radarr',
    title: 'Movie',
    path: 'A:\\Movies\\Movie',
    seasons: null,
    mediaFiles: [{ relativePath: 'Movie.mov', size: 100 }],
    extraFiles: [
      { relativePath: 'Movie.idx', type: 'subtitle' },
      { relativePath: 'Movie.sub', type: 'subtitle' },
    ],
  }]);
  assertEquals(result.sources, [{
    instanceName: 'Radarr',
    downloadId: hash,
    path: '/downloads/release/movie.mkv',
    importedPath: null,
    verification: 'unverified',
    reason: 'No download path mapping covers this path',
  }]);
});

Deno.test('a re-added torrent at a different path is not selected by hash', async () => {
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget(undefined, 'different-release')],
  );
  assertEquals(result.downloadJobs, []);
  assertStringIncludes(result.reason ?? '', 'manifest does not own');
});

Deno.test('a torrent associated with an unselected Arr title is retained', async () => {
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget([7, 99])],
    [qbitTarget()],
  );
  assertEquals(result.downloadJobs, []);
  assertStringIncludes(result.reason ?? '', 'not all attributable');
  assertStringIncludes(result.retainedPaths[0]?.reason ?? '', 'another title');
});

Deno.test('torrent cleanup errors instead of silently skipping an unreachable client', async () => {
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget(new Response('Fails.'))],
  );
  assertEquals(result.status, 'error');
  assertStringIncludes(result.reason ?? '', 'qBittorrent login failed');
});

Deno.test('partial batch selection keeps only fully verified qBittorrent cleanups', async () => {
  const verified = await resolveDownloadCleanup(
    'verified',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget()],
  );
  const failed = await resolveDownloadCleanup(
    'failed',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget(new Response('Fails.'))],
  );
  assertEquals([...selectVerifiedDownloadCleanups([verified, failed]).keys()], ['verified']);
});

Deno.test('a torrent retained by one selected title is retained for the whole batch', () => {
  const torrent = {
    instanceKey: 'db:1',
    jobId: hash,
    contentPath: '/downloads/shared',
    savePath: '/downloads',
  };
  const eligible = {
    ratingKey: 'eligible',
    status: 'resolved',
    downloadJobs: [torrent],
    orphanFiles: [],
    retainedPaths: [],
    observedDownloadJobKeys: new Set([`db:1:${hash}`]),
  } as unknown as ResolvedCleanupItem;
  const conflicting = {
    ratingKey: 'conflicting',
    status: 'error',
    reason: 'Another configured client failed',
    downloadJobs: [torrent],
    orphanFiles: [],
    retainedPaths: [],
    observedDownloadJobKeys: new Set([`db:1:${hash}`]),
  } as unknown as ResolvedCleanupItem;

  const reconciled = reconcileSharedDownloadCleanups([eligible, conflicting]);
  assertEquals(reconciled[0]?.status, 'unavailable');
  assertEquals(reconciled[0]?.downloadJobs, []);
  assertStringIncludes(reconciled[0]?.retainedPaths[0]?.reason ?? '', 'selected title');
  assertEquals(reconciled[1]?.status, 'error');
});

Deno.test('torrent cleanup resumes when a previously attempted torrent is now absent', async () => {
  const target = qbitTarget();
  const absentClient = new QbittorrentClient(
    'http://qbit:8080',
    '',
    '',
    ((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith('/app/version') ? new Response('v5.1.2') : Response.json([]),
      )) as typeof fetch,
  );
  target.client = new QbittorrentDownloadClient(absentClient);
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [target],
    new Set([`db:1:${hash}`]),
  );
  assertEquals(result.status, 'resolved');
  assertEquals(result.downloadJobs, []);
  assertStringIncludes(result.reason ?? '', 'previously started');
});

Deno.test('cleanup remains resumable after the attempted Arr record is also absent', async () => {
  const arr = arrTarget();
  arr.client = new ArrClient(
    'radarr',
    'http://radarr',
    'key',
    (() => Promise.resolve(Response.json([]))) as typeof fetch,
  );
  const target = qbitTarget();
  target.client = new QbittorrentDownloadClient(
    new QbittorrentClient(
      'http://qbit:8080',
      '',
      '',
      ((input: string | URL | Request) =>
        Promise.resolve(
          String(input).endsWith('/app/version') ? new Response('v5.1.2') : Response.json([]),
        )) as typeof fetch,
    ),
  );
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arr],
    [target],
    new Set([`db:1:${hash}`]),
    [],
    new Set([arr.instanceId]),
  );
  assertEquals(result.status, 'resolved');
  assertEquals(result.arrStatus, 'resolved');
  assertEquals(result.arrTargets, []);
});

Deno.test('optional history and extra-file failures do not block verified Arr deletion', async () => {
  const client = new ArrClient(
    'radarr',
    'http://radarr',
    'key',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/movie?tmdbId=')) {
        return Promise.resolve(Response.json([{
          id: 7,
          title: 'Movie',
          path: '/movies/Movie',
        }]));
      }
      return Promise.resolve(new Response('Unavailable', { status: 503 }));
    }) as typeof fetch,
  );
  const result = await resolveDownloadCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [{
      instanceId: 1,
      instanceName: 'Radarr',
      instanceType: 'radarr',
      instanceUrl: 'http://radarr',
      configurationUpdatedAt: 1,
      mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
      client,
      addImportExclusion: true,
      pathMappings: [],
    }],
    [],
  );
  assertEquals(result.arrStatus, 'resolved');
  assertEquals(result.arrTargets[0]?.path, '/movies/Movie');
  assertEquals(result.arrTargets[0]?.mediaFiles, null);
  assertEquals(result.arrTargets[0]?.extraFiles, null);
  assertEquals(result.status, 'unavailable');
});

Deno.test('bounded Sonarr inventory failures remain item-scoped cleanup errors', async () => {
  const client = new ArrClient(
    'sonarr',
    'http://sonarr',
    'key',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/series?tvdbId=')) {
        return Promise.resolve(Response.json([{
          id: 7,
          title: 'Show',
          path: '/tv/Show',
          seasons: [],
        }]));
      }
      return Promise.resolve(new Response('Inventory unavailable', { status: 503 }));
    }) as typeof fetch,
  );
  const result = await resolveDownloadCleanup(
    'plex-show',
    { title: 'Show', type: 'show', tmdbId: null, tvdbId: 10 },
    [{
      instanceId: 1,
      instanceName: 'Sonarr',
      instanceType: 'sonarr',
      instanceUrl: 'http://sonarr',
      configurationUpdatedAt: 1,
      mappingIdentity: '{"addImportExclusion":false,"pathMappings":[]}',
      client,
      addImportExclusion: false,
      pathMappings: [],
    }],
    [],
  );

  assertEquals(result.status, 'error');
  assertEquals(result.arrStatus, 'resolved');
  assertEquals(result.arrTargets[0]?.mediaFiles, null);
  assertStringIncludes(result.reason ?? '', 'Inventory unavailable');
});
