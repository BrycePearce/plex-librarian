import type {
  ArrCleanupTarget,
  MediaVersionPathPreview,
  VersionDeletionPreviewResponse,
} from '@plex-librarian/shared/types.ts';
import type { PlexMediaVersionPathPreview } from '../../integrations/plex/types.ts';
import type { ArrDeleteTarget, CoordinatedDeleteItem } from '../arr/delete.ts';
import { normalizeRemoteAbsolute } from './hardlinks.ts';
import { appendRemotePath } from './ownership.ts';
import { publicCleanupItem, type ResolvedCleanupItem } from './cleanup.ts';

export interface EligibleVersionArrTarget {
  target: ArrDeleteTarget;
  recordId: number | null;
  alreadyAbsent: boolean;
  preview: ArrCleanupTarget;
}

export interface VersionDeletionPlan {
  preview: VersionDeletionPreviewResponse;
  eligibleArrTargets: EligibleVersionArrTarget[];
  cleanup: ResolvedCleanupItem | null;
}

function normalizedComparison(path: string): string | null {
  return normalizeRemoteAbsolute(path)?.comparison ?? null;
}

function pathIsWithin(path: string, root: string): boolean {
  const normalizedPath = normalizeRemoteAbsolute(path);
  const normalizedRoot = normalizeRemoteAbsolute(root);
  if (!normalizedPath || !normalizedRoot || normalizedPath.separator !== normalizedRoot.separator) {
    return false;
  }
  return normalizedPath.comparison === normalizedRoot.comparison ||
    normalizedPath.comparison.startsWith(
      `${normalizedRoot.comparison}${normalizedRoot.separator}`,
    );
}

function publicVersionPreviews(
  versions: readonly PlexMediaVersionPathPreview[],
  selectedMediaIds: ReadonlySet<number>,
): MediaVersionPathPreview[] {
  return [...selectedMediaIds].map((mediaId) => {
    const version = versions.find((candidate) => candidate.mediaId === mediaId);
    if (!version) {
      return {
        mediaId,
        plexPaths: [],
        arrPaths: [],
        cleanupPaths: [],
        status: 'unavailable' as const,
        reason: 'This Media version is no longer reported by Plex',
        truncated: false,
      };
    }
    return {
      mediaId,
      plexPaths: version.paths,
      arrPaths: [],
      cleanupPaths: [],
      status: version.paths.length > 0 ? 'resolved' as const : 'unavailable' as const,
      ...(version.paths.length === 0
        ? { reason: 'Plex did not report an underlying path for this Media version' }
        : {}),
      truncated: version.truncated,
    };
  });
}

export function selectVersionDownloadCleanup(
  cleanup: ResolvedCleanupItem | null,
  selectedPaths: ReadonlySet<string>,
  allowPartialCoverage = false,
): ResolvedCleanupItem | null {
  if (!cleanup || selectedPaths.size === 0 || cleanup.status === 'error') return null;
  if (
    cleanup.status === 'resolved' && cleanup.downloadJobs.length === 0 &&
    cleanup.orphanFiles.length === 0 && cleanup.reason?.includes('previously started')
  ) return cleanup;
  const coveredPaths = new Set<string>();
  const downloadJobs = cleanup.downloadJobs.filter((job) => {
    const associations = cleanup.sources.filter((source) => source.downloadId === job.jobId);
    if (associations.length === 0) return false;
    const importedPaths = associations.map((source) =>
      source.importedPath ? normalizedComparison(source.importedPath) : null
    );
    const eligible = importedPaths.every((path) => path !== null && selectedPaths.has(path));
    if (eligible) {
      for (const path of importedPaths) if (path) coveredPaths.add(path);
    }
    return eligible;
  });
  const orphanFiles = cleanup.orphanFiles.filter((file) => {
    const importedPath = normalizedComparison(file.importedPath);
    const eligible = importedPath !== null && selectedPaths.has(importedPath);
    if (eligible) coveredPaths.add(importedPath);
    return eligible;
  });
  if (
    (downloadJobs.length === 0 && orphanFiles.length === 0) ||
    (!allowPartialCoverage && [...selectedPaths].some((path) => !coveredPaths.has(path)))
  ) return null;
  return {
    ...cleanup,
    status: 'resolved',
    reason: undefined,
    downloadJobs,
    orphanFiles,
    observedDownloadJobKeys: new Set(
      downloadJobs.map((job) => `${job.instanceKey}:${job.jobId}`),
    ),
  };
}

export async function buildVersionDeletionPlan({
  mediaType,
  item,
  selectedMediaIds,
  liveVersions,
  arrTargets,
  resolvedCleanup,
  cleanupConfigured,
  attemptedArrInstanceIds = new Set<number>(),
  allowPartialCoverage = false,
}: {
  mediaType: 'movie' | 'episode';
  item: CoordinatedDeleteItem;
  selectedMediaIds: ReadonlySet<number>;
  liveVersions: readonly PlexMediaVersionPathPreview[];
  arrTargets: readonly ArrDeleteTarget[];
  resolvedCleanup: ResolvedCleanupItem | null;
  cleanupConfigured: boolean;
  attemptedArrInstanceIds?: ReadonlySet<number>;
  allowPartialCoverage?: boolean;
}): Promise<VersionDeletionPlan> {
  const versions = publicVersionPreviews(liveVersions, selectedMediaIds);
  const selectedPaths = new Set(
    versions.flatMap((version) => version.plexPaths).flatMap((path) => {
      const normalized = normalizedComparison(path);
      return normalized ? [normalized] : [];
    }),
  );
  const unselectedPlexPaths = liveVersions
    .filter((version) => !selectedMediaIds.has(version.mediaId))
    .flatMap((version) => version.paths);
  const pathsComplete = liveVersions.every((version) => !version.truncated) &&
    versions.every((version) => version.status === 'resolved' && !version.truncated);

  const eligibleArrTargets: EligibleVersionArrTarget[] = [];
  const arrErrors: string[] = [];
  const arrUnsafeReasons: string[] = [];
  const arrCoveredPaths = new Set<string>();
  let arrSelectionMatched = false;

  if (mediaType === 'episode') {
    arrUnsafeReasons.push(
      'Sonarr deletion is series-wide; Plex Librarian cannot safely apply it to one episode version',
    );
  } else if (!pathsComplete) {
    arrUnsafeReasons.push(
      'Plex returned more version paths than the bounded preview can verify',
    );
  } else if (selectedPaths.size === 0) {
    arrUnsafeReasons.push('An exact Plex path is required before Radarr can be matched safely');
  } else if (item.tmdbId === null) {
    arrUnsafeReasons.push('No TMDB ID is available for Radarr lookup');
  } else {
    for (const target of arrTargets) {
      try {
        const record = await target.client.lookup(item.tmdbId);
        if (!record) {
          if (attemptedArrInstanceIds.has(target.instanceId)) {
            const preview = {
              instanceName: target.instanceName,
              type: target.client.type,
              title: item.title,
              path: null,
              seasons: null,
              mediaFiles: [],
              extraFiles: [],
            } satisfies ArrCleanupTarget;
            eligibleArrTargets.push({
              target,
              recordId: null,
              alreadyAbsent: true,
              preview,
            });
          }
          continue;
        }
        const [mediaFiles, extraFiles] = await Promise.all([
          target.client.mediaFiles(record.id),
          target.client.extraFiles(record.id).catch(() => []),
        ]);
        const preview = {
          instanceName: target.instanceName,
          type: target.client.type,
          title: record.title,
          path: record.path,
          seasons: record.seasons,
          mediaFiles,
          extraFiles,
        } satisfies ArrCleanupTarget;
        if (!record.path || !mediaFiles || mediaFiles.length === 0) continue;
        const managedPaths = mediaFiles.flatMap((file) => {
          const path = appendRemotePath(record.path!, file.relativePath);
          const normalized = path ? normalizedComparison(path) : null;
          return normalized ? [normalized] : [];
        });
        const matchesSelected = managedPaths.some((path) => selectedPaths.has(path));
        if (!matchesSelected) continue;
        arrSelectionMatched = true;
        const hasNonSelectedManagedPath = managedPaths.some((path) => !selectedPaths.has(path));
        const hasNonSelectedPlexPathInFolder = unselectedPlexPaths.some((path) =>
          pathIsWithin(path, record.path!)
        );
        if (hasNonSelectedManagedPath || hasNonSelectedPlexPathInFolder) {
          arrUnsafeReasons.push(
            `${target.instanceName} also owns an unselected version in the same movie folder`,
          );
          continue;
        }
        eligibleArrTargets.push({
          target,
          recordId: record.id,
          alreadyAbsent: false,
          preview,
        });
        for (const path of managedPaths) arrCoveredPaths.add(path);
      } catch (error) {
        arrErrors.push(
          `${target.instanceName}: ${error instanceof Error ? error.message : 'lookup failed'}`,
        );
      }
    }
  }

  if (
    !allowPartialCoverage &&
    eligibleArrTargets.length > 0 &&
    eligibleArrTargets.some((entry) => !entry.alreadyAbsent) &&
    [...selectedPaths].some((path) => !arrCoveredPaths.has(path))
  ) {
    eligibleArrTargets.length = 0;
    arrUnsafeReasons.push(
      'Not every selected Plex version path has an exact Radarr-managed match',
    );
  }

  const cleanup = mediaType === 'movie' && pathsComplete
    ? selectVersionDownloadCleanup(resolvedCleanup, selectedPaths, allowPartialCoverage)
    : null;
  const publicCleanup = cleanup ? publicCleanupItem(cleanup) : null;
  const arrStatus = eligibleArrTargets.length > 0
    ? 'resolved' as const
    : arrErrors.length > 0
    ? 'error' as const
    : 'unavailable' as const;
  const arrReason = arrStatus === 'error'
    ? arrErrors.join('; ')
    : arrStatus === 'unavailable'
    ? arrUnsafeReasons[0] ??
      'No Radarr record could be matched exactly to only the selected Plex version paths'
    : undefined;
  const cleanupStatus = cleanup
    ? 'resolved' as const
    : resolvedCleanup?.status === 'error'
    ? 'error' as const
    : 'unavailable' as const;
  const cleanupReason = cleanupStatus === 'error'
    ? resolvedCleanup?.reason
    : cleanupStatus === 'unavailable'
    ? mediaType === 'episode'
      ? 'Version-level qBittorrent cleanup is unavailable for episodes and season packs'
      : resolvedCleanup?.reason ??
        'No download payload could be tied exclusively to the selected Plex version paths'
    : undefined;

  const cleanupCoveredPaths = new Set<string>();
  if (cleanup) {
    const jobIds = new Set(cleanup.downloadJobs.map((job) => job.jobId));
    for (const source of cleanup.sources) {
      if (!jobIds.has(source.downloadId)) continue;
      const path = source.importedPath ? normalizedComparison(source.importedPath) : null;
      if (path) cleanupCoveredPaths.add(path);
    }
    for (const file of cleanup.orphanFiles) {
      const path = normalizedComparison(file.importedPath);
      if (path) cleanupCoveredPaths.add(path);
    }
  }
  const versionsWithApplicability = versions.map((version) => {
    const paths = version.plexPaths.flatMap((path) => {
      const normalized = normalizedComparison(path);
      return normalized ? [normalized] : [];
    });
    const arrPaths = version.plexPaths.filter((path) => {
      const normalized = normalizedComparison(path);
      return normalized !== null && arrCoveredPaths.has(normalized);
    });
    const cleanupPaths = version.plexPaths.filter((path) => {
      const normalized = normalizedComparison(path);
      return normalized !== null && cleanupCoveredPaths.has(normalized);
    });
    const arrApplies = paths.length > 0 && arrPaths.length === paths.length;
    const cleanupApplies = arrApplies && paths.length > 0 &&
      cleanupPaths.length === paths.length;
    return {
      ...version,
      arrPaths,
      cleanupPaths,
      arrStatus: arrApplies
        ? 'resolved' as const
        : arrStatus === 'error'
        ? 'error' as const
        : 'unavailable' as const,
      ...(!arrApplies
        ? { arrReason: arrReason ?? 'No exact Radarr-managed match for this version' }
        : {}),
      cleanupStatus: cleanupApplies
        ? 'resolved' as const
        : cleanupStatus === 'error'
        ? 'error' as const
        : 'unavailable' as const,
      ...(!cleanupApplies
        ? { cleanupReason: cleanupReason ?? 'No verified download cleanup for this version' }
        : {}),
    };
  });

  return {
    eligibleArrTargets,
    cleanup,
    preview: {
      mediaType,
      arrService: mediaType === 'episode' ? 'sonarr' : 'radarr',
      versions: versionsWithApplicability,
      arrConfigured: arrTargets.length > 0,
      arrStatus,
      arrReason,
      arrTargets: eligibleArrTargets.map((entry) => entry.preview),
      arrSelectionMatched,
      cleanupConfigured,
      cleanupStatus,
      cleanupReason,
      downloadJobs: publicCleanup?.downloadJobs ?? [],
      orphanFiles: publicCleanup?.orphanFiles ?? [],
      retainedPaths: publicCleanup?.retainedPaths ?? [],
    },
  };
}
