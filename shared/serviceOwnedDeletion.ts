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
  outcome?: 'succeeded' | 'accepted' | 'failed' | 'uncertain' | 'kept' | 'not_applicable';
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
    decisions: ServiceActionDecision[];
  }>;
}

export interface ServiceDeletionRequest extends ServiceDeletionChoices {
  clientRequestId: string;
  previewFingerprint: string;
}

export interface ServiceDeletionCreated {
  operationId: string;
  /** An idempotent retry returns the existing operation's current status. */
  status: DeletionOperationStatus;
  targetCount: number;
}
