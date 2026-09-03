import type {
  DownloadCleanupJob,
  DownloadCleanupPreviewItem,
} from '@plex-librarian/shared/types.ts';
import type { DownloadClientTarget, DownloadDiscoveryCandidate } from '../downloadClient.ts';
import type { VerifiedOrphanFile } from '../hardlinks.ts';
import type { PersistedSonarrReclamation } from '../sonarr/reclamation.ts';

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
  /** Missing means the legacy strict per-manifest-path authority. */
  authorizationMode?: 'manifest_paths' | 'whole_show_hash';
  sonarrAssociations?: Array<{
    instanceId: number;
    instanceUrl: string;
    configurationUpdatedAt: number;
    seriesId: number;
    hash: string;
    sourcePaths: string[];
  }>;
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

export type CleanupItemWithoutPlexPaths = Omit<
  DownloadCleanupPreviewItem,
  'plexPaths' | 'plexPathStatus' | 'plexPathReason' | 'plexPathsTruncated'
>;

export interface ResolvedCleanupItem extends CleanupItemWithoutPlexPaths {
  downloadJobs: ResolvedDownloadJob[];
  orphanFiles: VerifiedOrphanFile[];
  /** Every live job whose manifest owned one of this title's historical paths. */
  observedDownloadJobKeys?: Set<string>;
  sonarrReclamation?: PersistedSonarrReclamation;
}

export interface PersistedResolvedDownloadJob extends Omit<ResolvedDownloadJob, 'target'> {
  targetIdentity: Omit<DownloadClientTarget, 'client'>;
}

export interface PersistedResolvedCleanupItem
  extends Omit<ResolvedCleanupItem, 'downloadJobs' | 'observedDownloadJobKeys'> {
  downloadJobs: PersistedResolvedDownloadJob[];
}
