import type {
  DownloadCleanupJob,
  DownloadCleanupPreviewItem,
} from '@plex-librarian/shared/types.ts';
import type { ArrDeleteTarget, CoordinatedDeleteItem } from '../arr/delete.ts';
import type { DownloadClientTarget } from './downloadClient.ts';
import {
  type AttemptedOrphanFile,
  completedOrphanFileAttempt,
  deleteVerifiedOrphanFile,
  findRetainedSiblingPaths,
  type PayloadScanBudget,
  type VerifiedOrphanFile,
  verifyOrphanHardlink,
  verifyTrackedHardlinks,
} from './hardlinks.ts';
import {
  appendRemotePath,
  downloadJobOwnsPath,
  downloadPayloadIsExclusivelyOwned,
} from './ownership.ts';

export interface ResolvedDownloadJob extends DownloadCleanupJob {
  target: DownloadClientTarget;
  manifestFiles: Array<{ path: string; size: number | null }>;
  authorizedSourcePaths: string[];
}

type CleanupItemWithoutPlexPaths = Omit<
  DownloadCleanupPreviewItem,
  'plexPaths' | 'plexPathStatus' | 'plexPathReason' | 'plexPathsTruncated'
>;

export interface ResolvedCleanupItem extends CleanupItemWithoutPlexPaths {
  downloadJobs: ResolvedDownloadJob[];
  orphanFiles: VerifiedOrphanFile[];
  /** Every live job whose manifest owned one of this title's historical paths. */
  observedDownloadJobKeys?: Set<string>;
}

export interface DownloadedFileCleanupResult {
  deletedJobs: Array<{ provider: string; instanceName: string; jobId: string; name: string }>;
  alreadyRemovedJobs: Array<
    { provider: string; instanceName: string; jobId: string; name: string }
  >;
  deletedOrphanFiles: string[];
  alreadyRemovedOrphanFiles: string[];
}

export class DownloadedFileCleanupError extends Error {
  constructor(
    message: string,
    readonly result: DownloadedFileCleanupResult,
    readonly system: string,
    readonly target: string,
  ) {
    super(message);
    this.name = 'DownloadedFileCleanupError';
  }
}

export function reconcileSharedDownloadCleanups(
  cleanups: readonly ResolvedCleanupItem[],
): ResolvedCleanupItem[] {
  const observations = new Map<string, { eligible: Set<string>; observed: Set<string> }>();
  for (const cleanup of cleanups) {
    for (const key of cleanup.observedDownloadJobKeys ?? []) {
      const state = observations.get(key) ?? {
        eligible: new Set<string>(),
        observed: new Set<string>(),
      };
      state.observed.add(cleanup.ratingKey);
      observations.set(key, state);
    }
    for (const job of cleanup.downloadJobs) {
      const key = `${job.instanceKey}:${job.jobId}`;
      const state = observations.get(key) ?? {
        eligible: new Set<string>(),
        observed: new Set<string>(),
      };
      if (cleanup.status === 'resolved') state.eligible.add(cleanup.ratingKey);
      observations.set(key, state);
    }
  }
  const conflicted = new Set(
    [...observations].filter(([, state]) =>
      [...state.observed].some((ratingKey) => !state.eligible.has(ratingKey))
    ).map(([key]) => key),
  );
  if (conflicted.size === 0) return [...cleanups];

  return cleanups.map((cleanup): ResolvedCleanupItem => {
    const removed = cleanup.downloadJobs.filter((job) =>
      conflicted.has(`${job.instanceKey}:${job.jobId}`)
    );
    if (removed.length === 0) return cleanup;
    const downloadJobs = cleanup.downloadJobs.filter((job) =>
      !conflicted.has(`${job.instanceKey}:${job.jobId}`)
    );
    const retainedPaths = [...new Map([
      ...cleanup.retainedPaths,
      ...removed.map((job) => ({
        path: job.contentPath || job.savePath,
        reason:
          'This download job is also associated with a selected title that did not independently authorize its complete payload; the shared job and files are retained',
      })),
    ].map((entry) => [entry.path, entry])).values()];
    if (downloadJobs.length > 0 || cleanup.orphanFiles.length > 0) {
      return { ...cleanup, downloadJobs, retainedPaths };
    }
    if (cleanup.status !== 'resolved') return { ...cleanup, downloadJobs, retainedPaths };
    return {
      ...cleanup,
      status: 'unavailable',
      downloadJobs,
      reason: 'A matching download job is shared with another selected title and is retained',
      retainedPaths,
    };
  });
}

export function selectVerifiedDownloadCleanups(
  cleanups: Iterable<ResolvedCleanupItem>,
): Map<string, ResolvedCleanupItem> {
  const verified = new Map<string, ResolvedCleanupItem>();
  for (const cleanup of cleanups) {
    // Error results may contain jobs observed before another configured client
    // failed. They are deliberately excluded: only a completely resolved item is
    // safe to include in an optional partial-batch mutation.
    if (cleanup.status === 'resolved') verified.set(cleanup.ratingKey, cleanup);
  }
  return verified;
}

export async function executeDownloadedFileCleanup(
  cleanup: ResolvedCleanupItem,
  deletedDownloadJobKeys: Set<string>,
  deletedOrphanPaths: Set<string>,
  beforeDownloadJobDelete: (job: ResolvedDownloadJob, jobKey: string) => Promise<void> = () =>
    Promise.resolve(),
  deleteOrphanFile: (file: VerifiedOrphanFile) => Promise<void> = deleteVerifiedOrphanFile,
  beforeOrphanDelete: (file: VerifiedOrphanFile) => Promise<void> = () => Promise.resolve(),
): Promise<DownloadedFileCleanupResult> {
  const result: DownloadedFileCleanupResult = {
    deletedJobs: [],
    alreadyRemovedJobs: [],
    deletedOrphanFiles: [],
    alreadyRemovedOrphanFiles: [],
  };
  for (const job of cleanup.downloadJobs) {
    const jobKey = `${job.instanceKey}:${job.jobId}`;
    const publicJob = {
      provider: job.provider,
      instanceName: job.instanceName,
      jobId: job.jobId,
      name: job.name,
    };
    if (deletedDownloadJobKeys.has(jobKey)) {
      result.alreadyRemovedJobs.push(publicJob);
      continue;
    }
    try {
      const current = await job.target.client.findJob(job.jobId);
      const authorizedPaths = new Set(job.authorizedSourcePaths);
      if (
        !current || current.id !== job.jobId ||
        !authorizedPaths.size ||
        ![...authorizedPaths].some((path) => downloadJobOwnsPath(current, path)) ||
        !downloadPayloadIsExclusivelyOwned(current, authorizedPaths)
      ) {
        throw new Error(
          'Download job identity or manifest changed since verification; nothing was removed',
        );
      }
      await beforeDownloadJobDelete(job, jobKey);
      await job.target.client.deleteJob(job.jobId, { deleteData: true });
      deletedDownloadJobKeys.add(jobKey);
      result.deletedJobs.push(publicJob);
    } catch (error) {
      throw new DownloadedFileCleanupError(
        error instanceof Error ? error.message : 'download cleanup failed',
        result,
        job.provider,
        `${job.instanceName}: ${job.name}`,
      );
    }
  }
  for (const orphanFile of cleanup.orphanFiles) {
    if (deletedOrphanPaths.has(orphanFile.path)) {
      result.alreadyRemovedOrphanFiles.push(orphanFile.path);
      continue;
    }
    try {
      await beforeOrphanDelete(orphanFile);
      await deleteOrphanFile(orphanFile);
      deletedOrphanPaths.add(orphanFile.path);
      result.deletedOrphanFiles.push(orphanFile.path);
    } catch (error) {
      throw new DownloadedFileCleanupError(
        error instanceof Error ? error.message : 'orphan hardlink cleanup failed',
        result,
        'filesystem',
        orphanFile.path,
      );
    }
  }
  return result;
}

function externalId(item: CoordinatedDeleteItem): number | null {
  return item.type === 'movie' ? item.tmdbId : item.type === 'show' ? item.tvdbId : null;
}

export async function resolveDownloadCleanup(
  ratingKey: string,
  item: CoordinatedDeleteItem,
  arrTargets: ArrDeleteTarget[],
  downloadTargets: DownloadClientTarget[],
  attemptedDownloadJobKeys: ReadonlySet<string> = new Set(),
  attemptedOrphanFiles: readonly AttemptedOrphanFile[] = [],
  attemptedArrInstanceIds: ReadonlySet<number> = new Set(),
  payloadScanBudget?: PayloadScanBudget,
): Promise<ResolvedCleanupItem> {
  const id = externalId(item);
  if (id === null || arrTargets.length === 0) {
    return {
      ratingKey,
      status: 'unavailable',
      downloadJobs: [],
      reason: id === null
        ? 'No TMDB/TVDB ID is available for Arr history lookup'
        : 'This library is not mapped to Sonarr or Radarr',
      arrStatus: 'unavailable',
      arrReason: id === null
        ? 'No TMDB/TVDB ID is available for managed deletion'
        : 'This library is not mapped to Sonarr or Radarr',
      arrTargets: [],
      sources: [],
      orphanFiles: [],
      retainedPaths: [],
    };
  }

  const associationPaths = new Map<string, Set<string>>();
  const associationHashes = new Set<string>();
  const arrMediaIds = new Map<number, number | null>();
  const sharedAssociationHashes = new Set<string>();
  const sources = new Map<string, ResolvedCleanupItem['sources'][number]>();
  const orphanFiles: VerifiedOrphanFile[] = [];
  const inspectionWarnings = new Map<string, ResolvedCleanupItem['retainedPaths'][number]>();
  const resolvedArrTargets: ResolvedCleanupItem['arrTargets'] = [];
  const arrErrors: string[] = [];
  const historyErrors: string[] = [];
  const orphanAttemptErrors: string[] = [];
  let completedOrphanAttemptCount = 0;
  let completedArrAttemptCount = 0;
  const configuredDownloadRoots = new Set(
    arrTargets.flatMap((target) =>
      target.pathMappings.filter((mapping) => mapping.kind === 'download').map((mapping) =>
        mapping.localPath
      )
    ),
  );
  for (const attempt of attemptedOrphanFiles) {
    try {
      if (await completedOrphanFileAttempt(attempt, configuredDownloadRoots)) {
        completedOrphanAttemptCount++;
      }
    } catch (error) {
      orphanAttemptErrors.push(
        `Orphan cleanup retry: ${error instanceof Error ? error.message : 'path check failed'}`,
      );
    }
  }
  for (const arr of arrTargets) {
    let record;
    try {
      record = await arr.client.lookup(id);
    } catch (error) {
      arrErrors.push(
        `${arr.instanceName}: ${error instanceof Error ? error.message : 'lookup failed'}`,
      );
      continue;
    }
    if (!record) {
      arrMediaIds.set(arr.instanceId, null);
      if (attemptedArrInstanceIds.has(arr.instanceId)) completedArrAttemptCount++;
      continue;
    }
    arrMediaIds.set(arr.instanceId, record.id);
    const [mediaFiles, extraFiles] = await Promise.all([
      arr.client.mediaFiles(record.id).catch(() => null),
      arr.client.extraFiles(record.id).catch(() => null),
    ]);
    resolvedArrTargets.push({
      instanceName: arr.instanceName,
      type: arr.client.type,
      title: record.title,
      path: record.path,
      seasons: record.seasons,
      mediaFiles,
      extraFiles,
    });
    try {
      const torrentAssociations = await arr.client.torrentAssociations(record.id);
      for (const association of torrentAssociations) {
        associationHashes.add(association.hash);
        const hashPaths = associationPaths.get(association.hash) ?? new Set<string>();
        if (association.sourcePath) hashPaths.add(association.sourcePath);
        associationPaths.set(association.hash, hashPaths);
        if (association.sourcePath) {
          const trackedPaths = [
            ...(mediaFiles ?? []).map((file) => file.relativePath),
            ...(extraFiles ?? []).map((file) => file.relativePath),
          ];
          const currentManagedPaths = trackedPaths.flatMap((relativePath) => {
            const path = record.path ? appendRemotePath(record.path, relativePath) : null;
            return path ? [path] : [];
          });
          const verification = await verifyOrphanHardlink(
            arr.instanceName,
            association,
            arr.pathMappings,
            currentManagedPaths,
          );
          if (verification) {
            sources.set(
              `${arr.instanceId}:${association.hash}:${association.sourcePath}:${association.importedPath}`,
              verification.source,
            );
            if (verification.file) orphanFiles.push(verification.file);
          }
          orphanFiles.push(
            ...await verifyTrackedHardlinks(
              record.path,
              trackedPaths,
              association,
              arr.pathMappings,
            ),
          );
        }
      }
    } catch (error) {
      historyErrors.push(
        `${arr.instanceName}: ${error instanceof Error ? error.message : 'history lookup failed'}`,
      );
    }
  }

  if (downloadTargets.length > 0 && arrErrors.length === 0 && associationHashes.size > 0) {
    for (const arr of arrTargets) {
      for (const hash of associationHashes) {
        try {
          if (
            !await arr.client.downloadIdIsExclusiveTo(arrMediaIds.get(arr.instanceId) ?? null, hash)
          ) {
            sharedAssociationHashes.add(hash);
          }
        } catch (error) {
          historyErrors.push(
            `${arr.instanceName}: ${
              error instanceof Error ? error.message : 'download history lookup failed'
            }`,
          );
        }
      }
    }
  }

  const publicSources = [...sources.values()];
  if (arrErrors.length > 0) {
    const reason = [...new Set(arrErrors)].join('; ');
    return {
      ratingKey,
      status: 'error',
      downloadJobs: [],
      reason,
      arrStatus: 'error',
      arrReason: reason,
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles,
      retainedPaths: [...inspectionWarnings.values()],
    };
  }
  if (resolvedArrTargets.length === 0 && completedArrAttemptCount === 0) {
    return {
      ratingKey,
      status: 'unavailable',
      downloadJobs: [],
      reason: 'The item was not found in any mapped Sonarr or Radarr instance',
      arrStatus: 'unavailable',
      arrReason: 'The item was not found in any mapped Sonarr or Radarr instance',
      arrTargets: [],
      sources: [],
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
    };
  }
  if (orphanAttemptErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      downloadJobs: [],
      reason: [...new Set(orphanAttemptErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
    };
  }
  if (
    downloadTargets.length === 0 && orphanFiles.length === 0 &&
    completedOrphanAttemptCount === 0
  ) {
    return {
      ratingKey,
      status: 'unavailable',
      downloadJobs: [],
      reason: 'No download client connection is configured',
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
    };
  }
  if (historyErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      downloadJobs: [],
      reason: [...new Set(historyErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles,
      retainedPaths: [...inspectionWarnings.values()],
    };
  }

  const downloadJobs: ResolvedDownloadJob[] = [];
  const ownedLiveJobs: ResolvedDownloadJob[] = [];
  const observedDownloadJobKeys = new Set<string>();
  let completedAttemptCount = 0;
  let unownedLiveJobCount = 0;
  let nonExclusiveLiveJobCount = 0;
  const qbitErrors: string[] = [];
  for (const target of downloadTargets) {
    const instancePrefix = `${target.instanceKey}:`;
    const candidateHashes = new Set(associationHashes);
    for (const attemptedKey of attemptedDownloadJobKeys) {
      if (attemptedKey.startsWith(instancePrefix)) {
        candidateHashes.add(attemptedKey.slice(instancePrefix.length));
      }
    }
    for (const hash of candidateHashes) {
      const sourcePaths = associationPaths.get(hash) ?? new Set<string>();
      const sourcePath = sourcePaths.values().next().value ?? null;
      try {
        const job = await target.client.findJob(hash);
        if (!job) {
          if (attemptedDownloadJobKeys.has(`${target.instanceKey}:${hash}`)) {
            completedAttemptCount++;
          }
          continue;
        }
        if (![...sourcePaths].some((path) => downloadJobOwnsPath(job, path))) {
          // A hash can be re-added at a different save path, or appear in another
          // client instance. It is not the historical payload unless its full
          // manifest owns at least one exact Arr source path.
          unownedLiveJobCount++;
          continue;
        }
        const { id: _id, ...publicJob } = job;
        const resolvedJob = {
          ...publicJob,
          provider: target.provider,
          jobId: hash,
          instanceKey: target.instanceKey,
          instanceName: target.instanceName,
          sourcePath,
          authorizedSourcePaths: [...sourcePaths],
          target,
        };
        ownedLiveJobs.push(resolvedJob);
        observedDownloadJobKeys.add(`${target.instanceKey}:${hash}`);
        if (sharedAssociationHashes.has(hash)) {
          nonExclusiveLiveJobCount++;
          inspectionWarnings.set(job.contentPath || job.savePath, {
            path: job.contentPath || job.savePath,
            reason:
              'Arr history associates this download with another title; the shared job and payload are retained',
          });
          continue;
        }
        if (!downloadPayloadIsExclusivelyOwned(job, sourcePaths)) {
          nonExclusiveLiveJobCount++;
          inspectionWarnings.set(job.contentPath || job.savePath, {
            path: job.contentPath || job.savePath,
            reason:
              'Live download job contains files that are not individually attributed to this selected Arr title; the job and payload are retained',
          });
          continue;
        }
        downloadJobs.push(resolvedJob);
      } catch (error) {
        qbitErrors.push(
          `${target.instanceName}: ${error instanceof Error ? error.message : 'lookup failed'}`,
        );
      }
    }
  }

  if (qbitErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      downloadJobs,
      reason: [...new Set(qbitErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles,
      retainedPaths: [...inspectionWarnings.values()],
      observedDownloadJobKeys,
    };
  }
  // Never unlink a file underneath a live job that was retained because its complete
  // payload could not be attributed. A download client could otherwise restore the file, and
  // the user would still have an active job with a partially removed payload.
  const directOrphanFiles = selectDirectOrphanFiles(orphanFiles, ownedLiveJobs);
  const retainedPaths = [...new Map([
    ...inspectionWarnings.values(),
    ...await findRetainedSiblingPaths(
      directOrphanFiles,
      undefined,
      payloadScanBudget,
    ),
  ].map((entry) => [entry.path, entry])).values()];
  if (
    downloadJobs.length > 0 || completedAttemptCount > 0 || directOrphanFiles.length > 0 ||
    completedOrphanAttemptCount > 0
  ) {
    return {
      ratingKey,
      status: 'resolved',
      downloadJobs,
      ...(downloadJobs.length === 0 && directOrphanFiles.length === 0
        ? {
          reason: completedOrphanAttemptCount > 0
            ? 'Downloaded-file cleanup was previously started and the verified path is now absent'
            : 'Download cleanup was previously started and the job is now absent',
        }
        : {}),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: directOrphanFiles,
      retainedPaths,
      observedDownloadJobKeys,
    };
  }
  return {
    ratingKey,
    status: 'unavailable',
    downloadJobs: [],
    reason: associationHashes.size === 0
      ? 'Arr has no retained download import history for this item'
      : nonExclusiveLiveJobCount > 0
      ? 'A matching live download contains files that are not all attributable to this Arr title'
      : unownedLiveJobCount > 0
      ? 'A matching download ID exists, but its manifest does not own the historical source path'
      : 'The imported download is no longer present in configured download clients',
    arrStatus: 'resolved',
    arrTargets: resolvedArrTargets,
    sources: publicSources,
    orphanFiles: [],
    retainedPaths,
    observedDownloadJobKeys,
  };
}

export function selectDirectOrphanFiles(
  files: readonly VerifiedOrphanFile[],
  jobs: readonly ResolvedDownloadJob[],
): VerifiedOrphanFile[] {
  return [
    ...new Map(
      files.filter((file) =>
        !jobs.some((job) => job.jobId === file.hash && downloadJobOwnsPath(job, file.remotePath))
      ).map((file) => [file.path, file]),
    ).values(),
  ];
}

export function publicCleanupItem(item: ResolvedCleanupItem): CleanupItemWithoutPlexPaths {
  return {
    ratingKey: item.ratingKey,
    status: item.status,
    reason: item.reason,
    downloadJobs: item.downloadJobs.map(({
      target: _target,
      manifestFiles: _manifestFiles,
      authorizedSourcePaths: _authorizedSourcePaths,
      ...job
    }) => job),
    arrStatus: item.arrStatus,
    arrReason: item.arrReason,
    arrTargets: item.arrTargets,
    sources: item.sources,
    orphanFiles: item.orphanFiles.map((
      {
        hash: _hash,
        importedPath: _importedPath,
        importedRoot: _importedRoot,
        root: _root,
        boundary: _boundary,
        remotePath: _remotePath,
        dev: _dev,
        ino: _ino,
        ...file
      },
    ) => file),
    retainedPaths: item.retainedPaths,
  };
}
