import type { DeletionOperationStatus } from './types/deletion/operations.ts';

/** Public protocol for service-owned deletion; contains no credentials or host mappings. */
export interface ServiceDeletionSelection {
  ratingKey: string;
  mediaId?: number;
}

export interface ServiceDeletionChoices {
  quickCleanupThresholdDays?: number;
  libraryKey: string;
  targets: ServiceDeletionSelection[];
  arrSelected: boolean;
  qbSelected: boolean;
}

export interface ServiceActionDecision {
  actionId: string;
  service: 'plex' | 'sonarr' | 'radarr' | 'qb';
  targetId: string;
  requested: boolean;
  state: 'delete_candidate' | 'kept' | 'held' | 'not_applicable';
  reason: string;
  evidenceRevision: string;
  /** Live target presence; configuration alone does not imply an applicable destination. */
  presence?: 'current' | 'absent' | 'unknown';
  /** QB has verified import lineage to this media, not merely a potential path overlap. */
  matchedToSelection?: boolean;
  outcome?: 'succeeded' | 'accepted' | 'failed' | 'uncertain' | 'kept' | 'not_applicable';
  /** Durable request acknowledgement; does not imply observed removal. */
  requestAccepted?: boolean;
  /** Service target absence observed; catalog/monitoring follow-up may still be pending. */
  removalConfirmed?: boolean;
}

export interface ServiceDeletionPreview {
  fingerprint: string;
  arrConfigured: boolean;
  qbConfigured: boolean;
  canConfirm: boolean;
  targets: Array<{
    ratingKey: string;
    mediaId?: number;
    title: string;
    showTitle?: string;
    seasonIndex?: number | null;
    episodeIndex?: number | null;
    fileSize?: number | null;
    videoResolution?: string | null;
    fileName?: string;
    /** Display-only service paths from the already collected action scope. */
    files?: ServiceDeletionPreviewFile[];
    /** Number of observed action files, including any omitted by display limits. */
    fileCount?: number;
    filesTruncated?: boolean;
    /** Sonarr's file-ID action can also remove linked extras not enumerated here. */
    linkedExtrasIncluded?: boolean;
    decisions: ServiceActionDecision[];
  }>;
}

export interface ServiceDeletionPreviewFile {
  path: string;
  size: number | null;
  service: ServiceActionDecision['service'];
  actionId: string;
}

export interface ServiceDeletionRequest extends ServiceDeletionChoices {
  historicalCleanup?: { fingerprint: string; candidateIds: string[] };
  clientRequestId: string;
  previewFingerprint: string;
}

export interface ServiceDeletionCreated {
  operationId: string;
  /** An idempotent retry returns the existing operation's current status. */
  status: DeletionOperationStatus;
  targetCount: number;
}
