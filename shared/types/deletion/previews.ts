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
  cleanupConfigured: boolean;
  cleanupStatus: 'resolved' | 'unavailable' | 'error';
  cleanupReason?: string;
  downloadJobs: DownloadCleanupJob[];
  orphanFiles: ArrCleanupFile[];
  retainedPaths: ArrCleanupRetainedPath[];
}
