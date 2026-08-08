import type { ArrType } from '../integrations/arr.ts';
import type {
  ArrCleanupFile,
  ArrCleanupRetainedPath,
  ArrCleanupTarget,
  DownloadCleanupJob,
} from './cleanup.ts';

export interface MediaVersionPathPreview {
  mediaId: number;
  plexPaths: string[];
  arrPaths: string[];
  cleanupPaths: string[];
  status: 'resolved' | 'unavailable' | 'error';
  reason?: string;
  truncated: boolean;
  arrStatus?: 'resolved' | 'unavailable' | 'error';
  arrReason?: string;
  cleanupStatus?: 'resolved' | 'unavailable' | 'error';
  cleanupReason?: string;
}

export interface VersionDeletionPreviewResponse {
  mediaType: 'movie' | 'episode';
  arrService: ArrType;
  // Every live Plex version is included for advanced comparison context.
  availableVersions: MediaVersionPathPreview[];
  versions: MediaVersionPathPreview[];
  arrConfigured: boolean;
  arrStatus: 'resolved' | 'unavailable' | 'error';
  arrReason?: string;
  arrTargets: ArrCleanupTarget[];
  arrSelectionMatched: boolean;
  arrReassignStatus: 'resolved' | 'unavailable' | 'error';
  arrReassignReason?: string;
  radarrPathAdoption: RadarrPathAdoptionPreview;
  cleanupConfigured: boolean;
  cleanupStatus: 'resolved' | 'unavailable' | 'error';
  cleanupReason?: string;
  downloadJobs: DownloadCleanupJob[];
  orphanFiles: ArrCleanupFile[];
  retainedPaths: ArrCleanupRetainedPath[];
}

export type RadarrReassignmentMode =
  | 'existing_path'
  | 'adopt_safe_path'
  | 'remove_from_radarr'
  | 'unavailable';

export interface RadarrPathAdoptionPreview {
  mode: RadarrReassignmentMode;
  arrInstanceId?: number;
  movieId?: number;
  retainedMediaId?: number;
  originalPath?: string;
  retainedPath?: string;
  proposedMoviePath?: string;
  pathOwnership?: 'ordinary_radarr_library' | 'explicit_user_managed_location';
  requiresConsent: boolean;
  planFingerprint?: string;
  radarrVersion?: string;
  minimumRadarrVersion?: string;
  behaviorSummary?: {
    deleteEmptyFolders: boolean;
    fileDate: string;
    metadataConsumerCount: number;
    notificationConsumerCount: number;
  };
  tmdbId?: number;
  movieTitle?: string;
  movieYear?: number;
  selectedMediaId?: number;
  selectedPlexPath?: string;
  managedPath?: string;
  retainedPlexPath?: string;
  retainedFileSize?: number;
  originalMonitored?: boolean;
  createImportExclusion?: true;
  addImportExclusion?: true;
  deleteFiles?: false;
  reasonSafeAdoptionUnavailable?: string;
  blockingOperationId?: string;
  reason?: string;
}
