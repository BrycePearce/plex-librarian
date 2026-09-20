import type { ArrDeleteTarget, CoordinatedDeleteItem } from '../arr/delete.ts';
import type { ArrExtraFile, ArrManagedFile } from '../../integrations/arr/client.ts';

import {
  type DownloadClientTarget,
  downloadJobManifestFingerprint,
  downloadJobSummaryFingerprint,
} from './downloadClient.ts';
import {
  type AttemptedOrphanFile,
  normalizeRemoteAbsolute,
  type PayloadScanBudget,
  type VerifiedOrphanFile,
} from './hardlinks.ts';
import { downloadJobOwnsPath, downloadPayloadIsExclusivelyOwned } from './ownership.ts';

import type { ResolvedCleanupItem, ResolvedDownloadJob } from './cleanup/types.ts';
export type {
  CleanupItemWithoutPlexPaths,
  DirectPlexPathEvidence,
  DirectRetainedPathEvidence,
  PersistedResolvedCleanupItem,
  PersistedResolvedDownloadJob,
  ResolvedCleanupItem,
  ResolvedDownloadJob,
} from './cleanup/types.ts';

function canonicalAuthorizationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalAuthorizationValue).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalAuthorizationValue(entry)]),
    );
  }
  return value;
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
  options: { allowWholeShowHash?: boolean } = {},
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
  const sonarrAssociations = new Map<
    string,
    NonNullable<ResolvedDownloadJob['sonarrAssociations']>[number]
  >();
  const associationHashes = new Set<string>();
  const arrMediaIds = new Map<number, number | null>();
  const sharedAssociationHashes = new Set<string>();
  const sources = new Map<string, ResolvedCleanupItem['sources'][number]>();
  const orphanFiles: VerifiedOrphanFile[] = [];
  const inspectionWarnings = new Map<string, ResolvedCleanupItem['retainedPaths'][number]>();
  const resolvedArrTargets: ResolvedCleanupItem['arrTargets'] = [];
  const arrErrors: string[] = [];
  const historyErrors: string[] = [];
  const managedFileErrors: string[] = [];
  let completedArrAttemptCount = 0;
  // Historical unlink attempts are handled only by the durable legacy gate.
  void attemptedOrphanFiles;
  void payloadScanBudget;
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
    let mediaFiles: ArrManagedFile[] | null;
    let extraFiles: ArrExtraFile[] | null;
    try {
      [mediaFiles, extraFiles] = await Promise.all([
        arr.client.type === 'sonarr'
          ? arr.client.mediaFiles(record.id)
          : arr.client.mediaFiles(record.id).catch(() => null),
        arr.client.extraFiles(record.id).catch(() => null),
      ]);
    } catch (error) {
      managedFileErrors.push(
        `${arr.instanceName}: ${
          error instanceof Error ? error.message : 'managed-file inventory lookup failed'
        }`,
      );
      resolvedArrTargets.push({
        instanceName: arr.instanceName,
        type: arr.client.type,
        title: record.title,
        path: record.path,
        seasons: record.seasons,
        mediaFiles: null,
        extraFiles: null,
      });
      continue;
    }
    resolvedArrTargets.push({
      instanceName: arr.instanceName,
      type: arr.client.type,
      title: record.title,
      path: record.path,
      seasons: record.seasons,
      mediaFiles,
      extraFiles: extraFiles?.map(({ relativePath, type }) => ({ relativePath, type })) ?? null,
    });
    try {
      const torrentAssociations = await arr.client.torrentAssociations(record.id);
      for (const association of torrentAssociations) {
        associationHashes.add(association.hash);
        const hashPaths = associationPaths.get(association.hash) ?? new Set<string>();
        if (association.sourcePath) hashPaths.add(association.sourcePath);
        associationPaths.set(association.hash, hashPaths);
        if (arr.client.type === 'sonarr' && association.sourcePath) {
          const key = `${arr.instanceId}:${association.hash}`;
          const evidence = sonarrAssociations.get(key) ?? {
            instanceId: arr.instanceId,
            instanceUrl: arr.instanceUrl,
            configurationUpdatedAt: arr.configurationUpdatedAt,
            seriesId: record.id,
            hash: association.hash,
            sourcePaths: [],
          };
          if (!evidence.sourcePaths.includes(association.sourcePath)) {
            evidence.sourcePaths.push(association.sourcePath);
          }
          sonarrAssociations.set(key, evidence);
        }
        // Retain association metadata to scope current jobs, never old-path authority.
        sources.set(
          `${arr.instanceId}:${association.hash}:${association.sourcePath}:${association.importedPath}`,
          {
            instanceName: arr.instanceName,
            downloadId: association.hash,
            path: association.sourcePath ?? '',
            importedPath: association.importedPath,
            verification: 'unverified',
          },
        );
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
  if (managedFileErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      downloadJobs: [],
      reason: [...new Set(managedFileErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
    };
  }
  if (
    downloadTargets.length === 0
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
  let qbittorrentPathAccessJob: ResolvedCleanupItem['qbittorrentPathAccessJob'];
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
        const { id: currentId, manifestFiles: _manifestFiles, ...currentJob } = job;
        const currentPathAccessJob = {
          ...currentJob,
          provider: target.provider,
          instanceKey: target.instanceKey,
          instanceName: target.instanceName,
          jobId: currentId,
          sourcePath: job.contentPath,
        };
        qbittorrentPathAccessJob ??= currentPathAccessJob;
        if (![...sourcePaths].some((path) => downloadJobOwnsPath(job, path))) {
          qbittorrentPathAccessJob = currentPathAccessJob;
          // A hash can be re-added or moved. Association alone is insufficient;
          // callers may establish complete current-file proof through direct discovery.
          unownedLiveJobCount++;
          continue;
        }
        const { id: _id, ...publicJob } = job;
        const wholeShowAssociations = [...sonarrAssociations.values()]
          .filter((association) => association.hash === hash)
          .map((association) => ({
            ...association,
            sourcePaths: [...association.sourcePaths].sort(),
          }))
          .sort((left, right) => left.instanceId - right.instanceId);
        const wholeShowSourcePaths = wholeShowAssociations.flatMap((association) =>
          association.sourcePaths
        );
        const wholeShowHashCandidate = options.allowWholeShowHash === true &&
          item.type === 'show' && target.provider === 'qbittorrent' &&
          Number.isSafeInteger(item.tvdbId) && item.tvdbId! > 0 &&
          wholeShowAssociations.length > 0;
        const canUseWholeShowHash = wholeShowHashCandidate && job.id === hash &&
          Number.isSafeInteger(job.fileCount) && job.fileCount > 0 &&
          Number.isSafeInteger(job.size) && job.size > 0 &&
          normalizeRemoteAbsolute(job.contentPath) !== null &&
          normalizeRemoteAbsolute(job.savePath) !== null &&
          job.fileCount === job.manifestFiles.length &&
          wholeShowSourcePaths.some((path) => downloadJobOwnsPath(job, path)) &&
          job.manifestFiles.every((file) =>
            typeof file.path === 'string' && file.path.length > 0 &&
            Number.isSafeInteger(file.size) && file.size! >= 0
          );
        if (wholeShowHashCandidate && !canUseWholeShowHash) {
          throw new Error('qBittorrent returned malformed whole-show download evidence');
        }
        const resolvedJob: ResolvedDownloadJob = {
          ...publicJob,
          provider: target.provider,
          jobId: hash,
          instanceKey: target.instanceKey,
          instanceName: target.instanceName,
          sourcePath: canUseWholeShowHash ? wholeShowSourcePaths[0]! : sourcePath,
          authorizedSourcePaths: canUseWholeShowHash ? wholeShowSourcePaths : [...sourcePaths],
          provenance: 'arr_history' as const,
          authorizationMode: canUseWholeShowHash ? 'whole_show_hash' : 'manifest_paths',
          ...(canUseWholeShowHash
            ? {
              sonarrAssociations: wholeShowAssociations,
              ownershipSummaryFingerprint: await downloadJobSummaryFingerprint(job),
              manifestFingerprint: await downloadJobManifestFingerprint(job),
            }
            : {}),
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
        if (!canUseWholeShowHash && !downloadPayloadIsExclusivelyOwned(job, sourcePaths)) {
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
      qbittorrentPathAccessJob,
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
  const retainedPaths = [...inspectionWarnings.values()];
  if (unownedLiveJobCount > 0) {
    // A selected current job with a moved or unresolved payload cannot disappear
    // from the accepted job set merely because another job was easy to verify.
    return {
      qbittorrentPathAccessJob,
      ratingKey,
      status: 'unavailable',
      downloadJobs: [],
      reason:
        'A matching current download exists, but its current payload ownership could not be verified',
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: [],
      retainedPaths,
      observedDownloadJobKeys,
    };
  }
  if (
    downloadJobs.length > 0 || completedAttemptCount > 0
  ) {
    return {
      ratingKey,
      status: 'resolved',
      downloadJobs,
      ...(downloadJobs.length === 0
        ? {
          reason: 'Download cleanup was previously started and the job is now absent',
        }
        : {}),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: [],
      retainedPaths,
      observedDownloadJobKeys,
    };
  }
  return {
    ratingKey,
    status: 'unavailable',
    downloadJobs: [],
    qbittorrentPathAccessJob,
    reason: associationHashes.size === 0
      ? 'Arr has no retained download import history for this item'
      : nonExclusiveLiveJobCount > 0
      ? 'A matching live download contains files that are not all attributable to this Arr title'
      : unownedLiveJobCount > 0
      ? 'A matching current download exists, but its current payload ownership could not be verified'
      : 'The imported download is no longer present in configured download clients',
    arrStatus: 'resolved',
    arrTargets: resolvedArrTargets,
    sources: publicSources,
    orphanFiles: [],
    retainedPaths,
    observedDownloadJobKeys,
  };
}
