import type {
  DownloadCleanupJob,
  DownloadCleanupPreviewItem,
} from '@plex-librarian/shared/types.ts';
import type { ArrDeleteTarget, CoordinatedDeleteItem } from '../arr/delete.ts';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { plexPathMappings } from '../../db/schema.ts';
import {
  type DownloadClientTarget,
  type DownloadDiscoveryCandidate,
  downloadJobManifestFingerprint,
  downloadJobSummaryFingerprint,
} from './downloadClient.ts';
import {
  type AttemptedOrphanFile,
  completedOrphanFileAttempt,
  deleteVerifiedOrphanFile,
  findRetainedSiblingPaths,
  normalizeRemoteAbsolute,
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
import {
  lstatChain,
  type PlexNamespaceMappingRecord,
  resolvePlexToLocal,
} from './pathNamespace.ts';

export interface DirectPlexPathEvidence {
  serverId: number;
  libraryKey: string;
  plexPath: string;
  localPath: string;
  mappingId: number;
  mappingRevision: number;
  mappingPlexPath: string;
  mappingLocalPath: string;
  mappingCaseSensitive: boolean;
}

export interface DirectRetainedPathEvidence extends DirectPlexPathEvidence {
  size: number;
  device: string;
  inode: string;
  canonicalPath: string;
}

export interface ResolvedDownloadJob extends DownloadCleanupJob {
  target: DownloadClientTarget;
  manifestFiles: Array<{ path: string; size: number | null }>;
  authorizedSourcePaths: string[];
  directPathEvidence?: Array<{
    remotePath: string;
    localPath: string;
    size: number;
    device: string;
    inode: string;
    canonicalPath: string;
  }>;
  directPlexPathEvidence?: DirectPlexPathEvidence[];
  directRetainedPathEvidence?: DirectRetainedPathEvidence[];
  provenance?: 'arr_history' | 'direct_manifest';
  discoverySummaryFingerprint?: string;
  ownershipSummaryFingerprint?: string;
  manifestFingerprint?: string;
  directDiscoveryCandidates?: DownloadDiscoveryCandidate[];
  directPathMappings?: Array<{
    id: number;
    qbittorrentPath: string;
    localPath: string;
    caseSensitive: boolean;
    revision: number;
  }>;
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

export interface PersistedResolvedDownloadJob extends Omit<ResolvedDownloadJob, 'target'> {
  targetIdentity: Omit<DownloadClientTarget, 'client'>;
}

export interface PersistedResolvedCleanupItem
  extends Omit<ResolvedCleanupItem, 'downloadJobs' | 'observedDownloadJobKeys'> {
  downloadJobs: PersistedResolvedDownloadJob[];
}

export function persistResolvedCleanup(
  cleanup: ResolvedCleanupItem,
): PersistedResolvedCleanupItem {
  if (cleanup.status !== 'resolved') {
    throw new Error('Only a fully resolved download cleanup can be persisted');
  }
  const { observedDownloadJobKeys: _observedDownloadJobKeys, ...persisted } = cleanup;
  return {
    ...persisted,
    downloadJobs: cleanup.downloadJobs.map(({ target, ...job }) => ({
      ...job,
      targetIdentity: {
        provider: target.provider,
        instanceKey: target.instanceKey,
        configurationIdentity: target.configurationIdentity,
        instanceId: target.instanceId,
        instanceName: target.instanceName,
      },
    })),
  };
}

export function persistResolvedCleanupIdentity(
  cleanup: ResolvedCleanupItem,
): PersistedResolvedCleanupItem {
  const persisted = persistResolvedCleanup(cleanup);
  const selectedJobIds = new Set(persisted.downloadJobs.map((job) => job.jobId));
  const sources = [...new Map(
    persisted.sources.filter((source) => selectedJobIds.has(source.downloadId)).map((source) => [
      `${source.downloadId}:${source.importedPath ?? ''}`,
      source,
    ]),
  ).values()];
  return {
    ...persisted,
    // The torrent hash fixes the payload manifest. Keeping thousands of manifest
    // entries in every season target would only duplicate evidence that is fetched
    // and revalidated immediately before deletion.
    downloadJobs: persisted.downloadJobs.map((job) => ({ ...job, manifestFiles: [] })),
    // Execution only needs enough association evidence to prove coverage for the
    // selected jobs. Show-wide history and preview-only summaries belong to the
    // operation preview, not to every durable media target.
    sources,
    arrTargets: [],
    retainedPaths: [],
  };
}

export function rehydrateResolvedCleanup(
  cleanup: PersistedResolvedCleanupItem,
  targets: readonly DownloadClientTarget[],
): ResolvedCleanupItem {
  if (cleanup.status !== 'resolved') {
    throw new Error('The durable download cleanup is not resolved');
  }
  const downloadJobs = cleanup.downloadJobs.map(({ targetIdentity, ...job }) => {
    const matches = targets.filter((target) =>
      target.provider === targetIdentity.provider &&
      target.instanceKey === targetIdentity.instanceKey &&
      target.configurationIdentity === targetIdentity.configurationIdentity &&
      target.instanceId === targetIdentity.instanceId &&
      target.instanceName === targetIdentity.instanceName
    );
    if (matches.length !== 1) {
      throw new Error('The configured download client changed after cleanup was accepted');
    }
    if (
      typeof job.jobId !== 'string' || !job.jobId ||
      typeof targetIdentity.configurationIdentity !== 'string' ||
      !targetIdentity.configurationIdentity ||
      job.provider !== targetIdentity.provider ||
      job.instanceKey !== targetIdentity.instanceKey ||
      job.instanceName !== targetIdentity.instanceName ||
      !Array.isArray(job.authorizedSourcePaths) || job.authorizedSourcePaths.length === 0 ||
      job.authorizedSourcePaths.some((path) => typeof path !== 'string' || !path) ||
      (job.directPathEvidence !== undefined &&
        (job.provenance !== 'direct_manifest' ||
          !Array.isArray(job.directPlexPathEvidence) || job.directPlexPathEvidence.length === 0 ||
          !Array.isArray(job.directRetainedPathEvidence) ||
          job.directRetainedPathEvidence.length === 0 ||
          !/^[a-f0-9]{64}$/.test(job.discoverySummaryFingerprint ?? '') ||
          !/^[a-f0-9]{64}$/.test(job.ownershipSummaryFingerprint ?? '') ||
          !/^[a-f0-9]{64}$/.test(job.manifestFingerprint ?? '') ||
          !Array.isArray(job.directDiscoveryCandidates) ||
          job.directDiscoveryCandidates.length === 0 ||
          job.directDiscoveryCandidates.some((candidate) =>
            !candidate || typeof candidate.path !== 'string' || !candidate.path ||
            typeof candidate.caseSensitive !== 'boolean' ||
            normalizeRemoteAbsolute(candidate.path) === null
          ) ||
          JSON.stringify(job.directPathMappings) !== JSON.stringify(matches[0]!.pathMappings)))
    ) {
      throw new Error('The durable download cleanup identity is malformed');
    }
    return { ...job, target: matches[0]! };
  });
  return { ...cleanup, downloadJobs };
}

export interface DownloadedFileCleanupResult {
  deletedJobs: Array<{ provider: string; instanceName: string; jobId: string; name: string }>;
  alreadyRemovedJobs: Array<
    { provider: string; instanceName: string; jobId: string; name: string }
  >;
  deletedOrphanFiles: string[];
  alreadyRemovedOrphanFiles: string[];
}

async function assertDirectPlexMappingsUnchanged(
  evidence: readonly DirectPlexPathEvidence[],
): Promise<void> {
  if (evidence.length === 0) {
    throw new Error('Direct Plex path-mapping evidence is missing');
  }
  const scopes = new Map<string, { serverId: number; libraryKey: string }>();
  for (const item of evidence) {
    if (
      !Number.isSafeInteger(item.serverId) || item.serverId <= 0 || !item.libraryKey ||
      !item.plexPath || !item.localPath || !Number.isSafeInteger(item.mappingId) ||
      item.mappingId <= 0 || !Number.isSafeInteger(item.mappingRevision) ||
      item.mappingRevision <= 0 || !item.mappingPlexPath || !item.mappingLocalPath ||
      typeof item.mappingCaseSensitive !== 'boolean'
    ) throw new Error('Direct Plex path-mapping evidence is malformed');
    scopes.set(`${item.serverId}:${item.libraryKey}`, {
      serverId: item.serverId,
      libraryKey: item.libraryKey,
    });
  }
  const currentByScope = new Map<string, PlexNamespaceMappingRecord[]>();
  for (const [key, scope] of scopes) {
    const rows = await db.select().from(plexPathMappings).where(and(
      eq(plexPathMappings.serverId, scope.serverId),
      eq(plexPathMappings.libraryKey, scope.libraryKey),
    ));
    currentByScope.set(key, rows);
  }
  for (const item of evidence) {
    const rows = currentByScope.get(`${item.serverId}:${item.libraryKey}`) ?? [];
    const resolved = resolvePlexToLocal(item.plexPath, rows);
    if (
      !resolved || resolved.path !== item.localPath || resolved.mapping.id !== item.mappingId ||
      resolved.mapping.revision !== item.mappingRevision ||
      resolved.mapping.plexPath !== item.mappingPlexPath ||
      resolved.mapping.localPath !== item.mappingLocalPath ||
      resolved.mapping.caseSensitive !== item.mappingCaseSensitive
    ) throw new Error('Plex path mapping changed since direct cleanup was accepted');
  }
}

async function assertDirectRetainedPathsUnchanged(
  evidence: readonly DirectRetainedPathEvidence[],
): Promise<void> {
  for (const item of evidence) {
    const [info, canonical] = await Promise.all([
      lstatChain(item.localPath),
      Deno.realPath(item.localPath),
    ]);
    if (
      !info.isFile || info.isSymlink || info.size !== item.size ||
      String(info.dev) !== item.device || String(info.ino) !== item.inode ||
      canonical !== item.canonicalPath
    ) throw new Error('A retained Plex filesystem identity changed since preview');
  }
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
  const directDiscoveries = new Map<
    DownloadClientTarget['client'],
    NonNullable<ReturnType<NonNullable<DownloadClientTarget['client']['discoverJobs']>>>
  >();
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
      let current = job.directPathEvidence ? null : await job.target.client.findJob(job.jobId);
      const authorizedPaths = new Set(job.authorizedSourcePaths);
      if (job.directPathEvidence) {
        if (!job.target.client.discoverJobs) {
          throw new Error('Direct download discovery is unavailable during revalidation');
        }
        let discovery = directDiscoveries.get(job.target.client);
        if (!discovery) {
          discovery = job.target.client.discoverJobs(job.directDiscoveryCandidates ?? []);
          directDiscoveries.set(job.target.client, discovery);
        }
        const liveDiscovery = await discovery;
        current = liveDiscovery.jobs.find((candidate) => candidate.id === job.jobId) ?? null;
        for (const evidence of job.directPathEvidence) {
          const [info, canonical] = await Promise.all([
            Deno.lstat(evidence.localPath),
            Deno.realPath(evidence.localPath),
          ]);
          if (
            !info.isFile || info.isSymlink || info.size !== evidence.size ||
            String(info.dev) !== evidence.device || String(info.ino) !== evidence.inode ||
            canonical !== evidence.canonicalPath
          ) {
            throw new Error('Direct download filesystem ownership changed since preview');
          }
        }
        if (
          job.provenance !== 'direct_manifest' || !job.discoverySummaryFingerprint ||
          !job.ownershipSummaryFingerprint || !job.manifestFingerprint || !current ||
          liveDiscovery.summaryFingerprint !== job.discoverySummaryFingerprint ||
          await downloadJobSummaryFingerprint(current) !== job.ownershipSummaryFingerprint ||
          await downloadJobManifestFingerprint(current) !== job.manifestFingerprint ||
          JSON.stringify(job.directPathMappings) !== JSON.stringify(job.target.pathMappings)
        ) {
          throw new Error('Direct download manifest changed since preview');
        }
        await assertDirectPlexMappingsUnchanged(job.directPlexPathEvidence ?? []);
        await assertDirectPlexMappingsUnchanged(job.directRetainedPathEvidence ?? []);
        await assertDirectRetainedPathsUnchanged(job.directRetainedPathEvidence ?? []);
      }
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

export async function confirmedAttemptedDownloadJobAbsences(
  cleanup: ResolvedCleanupItem,
  attemptedJobKeys: ReadonlySet<string>,
): Promise<Set<string>> {
  const confirmed = new Set<string>();
  for (const job of cleanup.downloadJobs) {
    const key = `${job.instanceKey}:${job.jobId}`;
    if (attemptedJobKeys.has(key) && await job.target.client.findJob(job.jobId) === null) {
      confirmed.add(key);
    }
  }
  return confirmed;
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
      extraFiles: extraFiles?.map(({ relativePath, type }) => ({ relativePath, type })) ?? null,
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
          provenance: 'arr_history' as const,
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
