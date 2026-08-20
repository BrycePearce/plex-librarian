import type { DownloadCleanupJob } from './cleanup.ts';
import type { DeletionOperationCreated } from './operations.ts';

export interface SeasonRemovalPreviewResponse {
  fingerprint: string;
  expiresAt: number;
  libraryKey: string;
  seasonRatingKey: string;
  showRatingKey: string;
  showTitle: string;
  seasonTitle: string;
  seasonIndex: number;
  episodeCount: number;
  fileSize: number | null;
  coordinatedConfigured: boolean;
  sonarrStatus: 'resolved' | 'unavailable' | 'error';
  sonarrReason?: string;
  managedEpisodeCount: number;
  monitoredEpisodeCount: number;
  managedFileCount: number;
  sonarrActionAvailable: boolean;
  plexFiles: Array<{ path: string; size: number }>;
  sonarrFiles: Array<{ instanceName: string; path: string; size: number }>;
  cleanupConfigured: boolean;
  cleanupStatus: 'resolved' | 'unavailable' | 'error';
  cleanupReason?: string;
  downloadJobs: DownloadCleanupJob[];
  blockers: string[];
}

export interface SeasonRemovalRequest {
  clientRequestId: string;
  previewFingerprint: string;
  coordinated: boolean;
  cleanupDownloads: boolean;
}

export interface SeasonRemovalCreated extends DeletionOperationCreated {
  targetCount: 1;
}
