import type { ArrType } from '../integrations/arr.ts';

export interface DeleteItemsRequest {
  ratingKeys: string[];
  mode: 'coordinated' | 'plex-only';
  cleanupDownloads?: boolean;
}

export interface DownloadCleanupJob {
  provider: string;
  instanceKey: string;
  instanceName: string;
  jobId: string;
  name: string;
  state: string;
  size: number;
  uploaded: number;
  ratio: number | null;
  seedingTime: number;
  completedAt: number | null;
  contentPath: string;
  savePath: string;
  trackerHost: string | null;
  fileCount: number;
  files: DownloadCleanupJobFile[];
  filesTruncated: boolean;
  sourcePath: string | null;
}

export interface DownloadCleanupJobFile {
  path: string;
  size: number | null;
}

export interface ArrCleanupExtraFile {
  relativePath: string;
  type: 'subtitle' | 'metadata' | 'other';
}

export interface ArrCleanupMediaFile {
  relativePath: string;
  size: number | null;
}

export interface ArrCleanupSeason {
  seasonNumber: number;
  episodeFileCount: number | null;
  size: number | null;
}

export interface ArrCleanupTarget {
  instanceName: string;
  type: ArrType;
  title: string;
  path: string | null;
  seasons: ArrCleanupSeason[] | null;
  mediaFiles: ArrCleanupMediaFile[] | null;
  extraFiles: ArrCleanupExtraFile[] | null;
}

export interface ArrCleanupSource {
  instanceName: string;
  downloadId: string;
  path: string;
  importedPath: string | null;
  verification: 'hardlink' | 'unverified';
  localPath?: string;
  reason?: string;
}

export interface ArrCleanupFile {
  path: string;
  size: number;
  method: 'hardlink';
}

export interface ArrCleanupRetainedPath {
  path: string;
  reason: string;
}

export interface DownloadCleanupPreviewItem {
  ratingKey: string;
  plexPaths: string[];
  plexPathStatus: 'resolved' | 'unavailable' | 'error';
  plexPathReason?: string;
  plexPathsTruncated: boolean;
  status: 'resolved' | 'unavailable' | 'error';
  downloadJobs: DownloadCleanupJob[];
  reason?: string;
  arrStatus: 'resolved' | 'unavailable' | 'error';
  arrReason?: string;
  arrTargets: ArrCleanupTarget[];
  sources: ArrCleanupSource[];
  orphanFiles: ArrCleanupFile[];
  retainedPaths: ArrCleanupRetainedPath[];
}

export interface DownloadCleanupPreviewResponse {
  downloadClientsConfigured: boolean;
  coordinatedConfigured: boolean;
  items: DownloadCleanupPreviewItem[];
}

export interface DeleteItemsResponse {
  deleted: string[];
  removedByAppRatingKeys: string[];
  partial: Array<{
    ratingKey: string;
    deletedInstances: Array<
      { instanceId: number; instanceName: string; alreadyAbsent: boolean }
    >;
    failedInstances: Array<
      { instanceId: number; instanceName: string; error: string }
    >;
  }>;
  failed: { ratingKey: string; error: string }[];
  outcomes: DeleteItemOutcome[];
}

export type DeletionStageStatus = 'deleted' | 'already-absent' | 'failed';

export interface DeletionStageOutcome {
  system: string;
  target: string;
  status: DeletionStageStatus;
  error?: string;
}

export interface DeleteItemOutcome {
  ratingKey: string;
  stages: DeletionStageOutcome[];
}

export interface DeleteMediaVersionsResponse {
  deletedMediaIds: number[];
  removedByAppMediaIds: number[];
  failed: Array<{ mediaId: number; error: string }>;
  fileSizeFreed: number;
  outcomes: DeletionStageOutcome[];
}
