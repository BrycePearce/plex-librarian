import { assertEquals } from '@std/assert';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import type { VerifiedOrphanFile } from './hardlinks.ts';
import {
  bindSonarrPathOwnership,
  type ResolvedCleanupItem,
  revalidateAcceptedSonarrPathOwnership,
} from './cleanup.ts';
import { selectVersionDownloadCleanup } from './versionPlanning.ts';
import { classifySonarrOwnedPaths } from './sonarrPathOwnership.ts';

const hashA = 'a'.repeat(40);
const hashB = 'b'.repeat(40);
const hashC = 'c'.repeat(40);

function proof(nlink = 2): VerifiedOrphanFile {
  return {
    hash: hashA,
    path: '/downloads/release/episode.mkv',
    importedPath: '/library/show/episode.mkv',
    importedRoot: '/library',
    root: '/downloads',
    boundary: '/downloads/release',
    remotePath: '/remote/release/episode.mkv',
    size: 10,
    method: 'hardlink',
    dev: 1,
    ino: 2,
    nlink,
    rootDevice: '1',
    rootInode: '10',
    importedRootDevice: '1',
    importedRootInode: '11',
    managedFileId: 7,
    managedFileSize: 10,
    managedPath: '/sonarr/show/episode.mkv',
    ...(nlink === 2 ? { strictTwoLinkProof: true as const } : {}),
  };
}

function job(id = hashB): DownloadJob {
  return {
    id,
    name: 'release',
    state: 'uploading',
    size: 10,
    uploaded: 0,
    completedAt: null,
    ratio: null,
    seedingTime: 0,
    contentPath: '/q/release/episode.mkv',
    savePath: '/q',
    trackerHost: null,
    fileCount: 1,
    files: [{ path: 'release/episode.mkv', size: 10 }],
    filesTruncated: false,
    manifestFiles: [{ path: 'release/episode.mkv', size: 10 }],
  };
}

function target(
  options: { jobs?: DownloadJob[]; fail?: boolean; mapped?: boolean } = {},
): DownloadClientTarget {
  return {
    provider: 'qbittorrent',
    instanceKey: 'qb:1',
    instanceName: 'qBittorrent',
    configurationIdentity: 'identity',
    instanceId: 1,
    pathMappings: [{
      id: 1,
      qbittorrentPath: options.mapped === false ? '/elsewhere' : '/q',
      localPath: options.mapped === false ? '/elsewhere' : '/downloads',
      caseSensitive: true,
      revision: 1,
    }],
    client: {
      findJob: () => Promise.resolve(null),
      deleteJob: () => Promise.resolve(),
      discoverJobs: () =>
        options.fail
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({ jobs: options.jobs ?? [], summaryFingerprint: 'summary' }),
    },
  };
}

Deno.test('Sonarr path ownership deletes with no configured client or reachable non-owner', async () => {
  assertEquals(
    (await classifySonarrOwnedPaths({
      files: [proof()],
      downloadTargets: [],
      selectedJobKeys: new Set(),
    }))[0]?.ownershipDisposition,
    'delete',
  );
  assertEquals(
    (await classifySonarrOwnedPaths({
      files: [proof()],
      downloadTargets: [target()],
      selectedJobKeys: new Set(),
    }))[0]?.ownershipDisposition,
    'delete',
  );
});

Deno.test('Sonarr path ownership distinguishes selected and unselected different-hash owners', async () => {
  const client = target({ jobs: [job()] });
  assertEquals(
    (await classifySonarrOwnedPaths({
      files: [proof()],
      downloadTargets: [client],
      selectedJobKeys: new Set(),
    }))[0]?.ownershipDisposition,
    'retain_live_qbittorrent',
  );
  assertEquals(
    (await classifySonarrOwnedPaths({
      files: [proof()],
      downloadTargets: [client],
      selectedJobKeys: new Set([`qb:1:${hashB}`]),
    }))[0]?.ownershipDisposition,
    'delete',
  );

  const cleanup = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [],
    sources: [],
    orphanFiles: [proof()],
    retainedPaths: [],
    sonarrReclamation: { inventoryIdentity: 'accepted', proofs: [proof()] },
  } as unknown as ResolvedCleanupItem;
  const retained = await bindSonarrPathOwnership(cleanup, [client], false);
  assertEquals(retained.orphanFiles, []);
  assertEquals(
    selectVersionDownloadCleanup(
      retained,
      new Set(['/sonarr/show/episode.mkv']),
    )?.sonarrReclamation?.proofs[0]?.ownershipDisposition,
    'retain_live_qbittorrent',
  );
});

Deno.test('a different-hash exact owner uses the existing selectable payload authorization', async () => {
  const cleanup = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [],
    sources: [],
    orphanFiles: [proof()],
    retainedPaths: [],
    sonarrReclamation: { inventoryIdentity: 'accepted', proofs: [proof()] },
  } as unknown as ResolvedCleanupItem;

  const selected = await bindSonarrPathOwnership(cleanup, [target({ jobs: [job()] })], true);
  assertEquals(selected.downloadJobs.map((entry) => entry.jobId), [hashB]);
  assertEquals(
    selected.sources.map((entry) => ({
      downloadId: entry.downloadId,
      importedPath: entry.importedPath,
    })),
    [{ downloadId: hashB, importedPath: '/sonarr/show/episode.mkv' }],
  );
  const scoped = selectVersionDownloadCleanup(
    selected,
    new Set(['/sonarr/show/episode.mkv']),
    true,
  );
  assertEquals(scoped?.downloadJobs.map((entry) => entry.jobId), [hashB]);
  assertEquals(scoped?.orphanFiles.map((entry) => entry.path), [proof().path]);
  assertEquals(selected.sonarrReclamation?.proofs[0]?.ownershipDisposition, 'delete');
});

Deno.test('selected ownership stays blocked while another applicable client is unreachable', async () => {
  const cleanup = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [],
    sources: [],
    orphanFiles: [proof()],
    retainedPaths: [],
    sonarrReclamation: { inventoryIdentity: 'accepted', proofs: [proof()] },
  } as unknown as ResolvedCleanupItem;
  const unreachable = {
    ...target({ fail: true }),
    instanceKey: 'qb:2',
    instanceName: 'qBittorrent B',
    configurationIdentity: 'identity-2',
    instanceId: 2,
    pathMappings: [{
      id: 2,
      qbittorrentPath: '/q',
      localPath: '/downloads',
      caseSensitive: true,
      revision: 1,
    }],
  } satisfies DownloadClientTarget;

  const selected = await bindSonarrPathOwnership(
    cleanup,
    [target({ jobs: [job()] }), unreachable],
    true,
  );
  assertEquals(selected.status, 'error');
  assertEquals(selected.reason?.includes('offline'), true);
  assertEquals(selected.sonarrReclamation?.proofs[0]?.ownershipDisposition, 'unverified');
});

Deno.test('selected payload is blocked when an unselected job owns the same exact entry', async () => {
  const cleanup = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [],
    sources: [],
    orphanFiles: [proof()],
    retainedPaths: [],
    sonarrReclamation: { inventoryIdentity: 'accepted', proofs: [proof()] },
  } as unknown as ResolvedCleanupItem;
  const sharedOwner = job(hashC);
  sharedOwner.manifestFiles = [
    ...sharedOwner.manifestFiles,
    { path: 'release/unrelated.mkv', size: 10 },
  ];
  sharedOwner.files = [...sharedOwner.manifestFiles];
  sharedOwner.fileCount = 2;
  const secondClient = {
    ...target({ jobs: [sharedOwner] }),
    instanceKey: 'qb:2',
    instanceName: 'qBittorrent B',
    configurationIdentity: 'identity-2',
    instanceId: 2,
  } satisfies DownloadClientTarget;

  const selected = await bindSonarrPathOwnership(
    cleanup,
    [target({ jobs: [job()] }), secondClient],
    true,
  );
  assertEquals(selected.downloadJobs.map((entry) => entry.jobId), [hashB]);
  assertEquals(selected.status, 'error');
  assertEquals(
    selected.sonarrReclamation?.proofs[0]?.ownershipDisposition,
    'retain_live_qbittorrent',
  );
  assertEquals(
    selected.sonarrReclamation?.proofs[0]?.ownershipJobs?.map((owner) => owner.selected),
    [true, false],
  );
});

Deno.test('a different-hash multi-file owner is authorized across the complete Sonarr scope', async () => {
  const first = proof();
  const second = {
    ...proof(),
    path: '/downloads/release/episode-2.mkv',
    importedPath: '/library/show/episode-2.mkv',
    remotePath: '/remote/release/episode-2.mkv',
    managedFileId: 8,
    managedPath: '/sonarr/show/episode-2.mkv',
    ino: 3,
  };
  const owner = {
    ...job(),
    size: 20,
    contentPath: '/q/release',
    fileCount: 2,
    files: [
      { path: 'release/episode.mkv', size: 10 },
      { path: 'release/episode-2.mkv', size: 10 },
    ],
    manifestFiles: [
      { path: 'release/episode.mkv', size: 10 },
      { path: 'release/episode-2.mkv', size: 10 },
    ],
  };
  const cleanup = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [],
    sources: [],
    orphanFiles: [first, second],
    retainedPaths: [],
    sonarrReclamation: { inventoryIdentity: 'accepted', proofs: [first, second] },
  } as unknown as ResolvedCleanupItem;

  const selected = await bindSonarrPathOwnership(cleanup, [target({ jobs: [owner] })], true);
  assertEquals(selected.downloadJobs.map((entry) => entry.jobId), [hashB]);
  assertEquals(
    selected.sonarrReclamation?.proofs.map((entry) => entry.ownershipDisposition),
    ['delete', 'delete'],
  );
});

Deno.test('only an unreachable applicable client makes Sonarr ownership unverified', async () => {
  const result = await classifySonarrOwnedPaths({
    files: [proof()],
    downloadTargets: [target({ mapped: false, fail: true }), target({ fail: true })],
    selectedJobKeys: new Set(),
  });
  assertEquals(result[0]?.ownershipDisposition, 'unverified');
  assertEquals(result[0]?.ownershipReason.includes('offline'), true);
});

Deno.test('an incomplete inspection covering the managed entry blocks the Sonarr mutation', async () => {
  const unavailable = target({ fail: true });
  unavailable.pathMappings = [{
    id: 2,
    qbittorrentPath: '/q',
    localPath: '/library',
    caseSensitive: true,
    revision: 1,
  }];
  const result = await classifySonarrOwnedPaths({
    files: [proof()],
    downloadTargets: [unavailable],
    selectedJobKeys: new Set(),
  });
  assertEquals(result[0]?.ownershipDisposition, 'unverified');
  assertEquals(result[0]?.sonarrMutationUnsafe, true);
});

Deno.test('execution revalidation only downgrades paths accepted for deletion', async () => {
  const acceptedDelete = {
    ...proof(),
    ownershipDisposition: 'delete' as const,
    ownershipReason: 'accepted',
    ownershipInspections: [],
    ownershipJobs: [],
  };
  const cleanup = {
    ratingKey: 'show',
    status: 'resolved',
    downloadJobs: [],
    arrStatus: 'resolved',
    arrTargets: [],
    sources: [],
    orphanFiles: [acceptedDelete],
    retainedPaths: [],
    sonarrReclamation: { inventoryIdentity: 'accepted', proofs: [acceptedDelete] },
  } as unknown as ResolvedCleanupItem;
  const downgraded = await revalidateAcceptedSonarrPathOwnership(
    cleanup,
    [target({ jobs: [job()] })],
  );
  assertEquals(downgraded.orphanFiles, []);
  assertEquals(
    downgraded.sonarrReclamation?.proofs[0]?.ownershipDisposition,
    'retain_live_qbittorrent',
  );

  const acceptedRetain = {
    ...acceptedDelete,
    ownershipDisposition: 'retain_live_qbittorrent' as const,
    ownershipReason: 'accepted live owner',
  } as NonNullable<ResolvedCleanupItem['sonarrReclamation']>['proofs'][number];
  const retained = await revalidateAcceptedSonarrPathOwnership({
    ...cleanup,
    orphanFiles: [],
    sonarrReclamation: { ...cleanup.sonarrReclamation!, proofs: [acceptedRetain] },
  }, []);
  assertEquals(retained.orphanFiles, []);
  assertEquals(
    retained.sonarrReclamation?.proofs[0]?.ownershipDisposition,
    'retain_live_qbittorrent',
  );
});

Deno.test('execution revalidation downgrades when an accepted client inspection disappears', async () => {
  const accepted = await bindSonarrPathOwnership(
    {
      ratingKey: 'show',
      status: 'resolved',
      downloadJobs: [],
      arrStatus: 'resolved',
      arrTargets: [],
      sources: [],
      orphanFiles: [proof()],
      retainedPaths: [],
      sonarrReclamation: { inventoryIdentity: 'accepted', proofs: [proof()] },
    } as unknown as ResolvedCleanupItem,
    [target()],
    false,
  );
  assertEquals(accepted.orphanFiles.length, 1);
  assertEquals(accepted.sonarrReclamation?.proofs[0]?.ownershipInspections?.length, 1);

  const revalidated = await revalidateAcceptedSonarrPathOwnership(accepted, []);
  assertEquals(revalidated.orphanFiles, []);
  assertEquals(revalidated.sonarrReclamation?.proofs[0]?.ownershipDisposition, 'unverified');
  assertEquals(
    revalidated.sonarrReclamation?.proofs[0]?.ownershipReason?.includes(
      'accepted qBittorrent ownership inspection is no longer valid',
    ),
    true,
  );
});

Deno.test('execution revalidation preserves a durably attempted unlink for absence confirmation', async () => {
  const accepted = await bindSonarrPathOwnership(
    {
      ratingKey: 'show',
      status: 'resolved',
      downloadJobs: [],
      arrStatus: 'resolved',
      arrTargets: [],
      sources: [],
      orphanFiles: [proof()],
      retainedPaths: [],
      sonarrReclamation: { inventoryIdentity: 'accepted', proofs: [proof()] },
    } as unknown as ResolvedCleanupItem,
    [target()],
    false,
  );
  accepted.sonarrReclamation!.proofs[0]!.unlinkAttemptedAt = 10;

  const revalidated = await revalidateAcceptedSonarrPathOwnership(
    accepted,
    [],
    new Set([proof().path]),
  );
  assertEquals(revalidated.orphanFiles.map((entry) => entry.path), [proof().path]);
  assertEquals(revalidated.sonarrReclamation?.proofs[0]?.ownershipDisposition, 'delete');
});

Deno.test('an attempted but still-present unlink remains subject to live ownership', async () => {
  const accepted = await bindSonarrPathOwnership(
    {
      ratingKey: 'show',
      status: 'resolved',
      downloadJobs: [],
      arrStatus: 'resolved',
      arrTargets: [],
      sources: [],
      orphanFiles: [proof()],
      retainedPaths: [],
      sonarrReclamation: { inventoryIdentity: 'accepted', proofs: [proof()] },
    } as unknown as ResolvedCleanupItem,
    [],
    false,
  );
  accepted.sonarrReclamation!.proofs[0]!.unlinkAttemptedAt = 10;

  const revalidated = await revalidateAcceptedSonarrPathOwnership(
    accepted,
    [target({ jobs: [job()] })],
  );
  assertEquals(revalidated.orphanFiles, []);
  assertEquals(
    revalidated.sonarrReclamation?.proofs[0]?.ownershipDisposition,
    'retain_live_qbittorrent',
  );
});

Deno.test('paths without the exact two-link Sonarr proof are never classified', async () => {
  assertEquals(
    (await classifySonarrOwnedPaths({
      files: [proof(3)],
      downloadTargets: [],
      selectedJobKeys: new Set(),
    })).length,
    0,
  );
});

Deno.test('a live job owning the Sonarr-managed entry blocks the Sonarr mutation', async () => {
  const managedJob = {
    ...job(),
    contentPath: '/q/show/episode.mkv',
    files: [{ path: 'show/episode.mkv', size: 10 }],
    manifestFiles: [{ path: 'show/episode.mkv', size: 10 }],
  };
  const client = target({ jobs: [managedJob] });
  client.pathMappings = [{
    id: 2,
    qbittorrentPath: '/q',
    localPath: '/library',
    caseSensitive: true,
    revision: 1,
  }];

  const result = await classifySonarrOwnedPaths({
    files: [proof()],
    downloadTargets: [client],
    selectedJobKeys: new Set(),
  });

  assertEquals(result[0]?.sonarrMutationUnsafe, true);
  assertEquals(result[0]?.ownershipReason.includes('Sonarr-managed directory entry'), true);
});
