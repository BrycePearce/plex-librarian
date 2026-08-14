import type { DuplicateEpisodeGroup } from './duplicates.ts';
import type { DeletionOperationStatus } from '../deletion/operations.ts';

export interface SeasonVersionProfileMember {
  episodeRatingKey: string;
  mediaId: number;
}

export interface SeasonVersionProfile {
  id: string;
  label: string;
  coverageCount: number;
  /** Exact technical fingerprints condensed into this user-facing lane. */
  technicalVariantCount: number;
  totalFileSize: number | null;
  /** Human-readable bitrate range across this lane's episode members. */
  bitrateSummary: string | null;
  videoSummary: string;
  audioSummary: string[];
  subtitleSummary: string[];
  sourceHints: string[];
  members: SeasonVersionProfileMember[];
}

export interface SeasonVersionAnalysisResponse {
  season: {
    libraryKey: string;
    showRatingKey: string;
    seasonRatingKey: string;
    showTitle: string;
    seasonIndex: number;
  };
  analyzedEpisodeCount: number;
  recommendedProfileId: string | null;
  profiles: SeasonVersionProfile[];
  episodes: DuplicateEpisodeGroup[];
  uncertainEpisodeRatingKeys: string[];
}

export type SeasonDeletionOutcome =
  | 'plex_only'
  | 'automatic_adoption';

export interface SeasonDeletionSelection {
  episodeRatingKey: string;
  mediaIds: number[];
}

export interface SeasonDeletionIntent {
  selections: SeasonDeletionSelection[];
  coordinateSonarr: boolean;
  cleanupDownloads: boolean;
}

export interface SeasonCleanupRequest extends SeasonDeletionIntent {
  clientRequestId: string;
  previewFingerprint: string;
}

export interface SeasonCleanupResponse {
  operationId: string;
  status: DeletionOperationStatus;
  targetCount: number;
}

export interface SeasonDeletionMemberPreview {
  episodeRatingKey: string;
  selectedMediaIds: number[];
  retainedMediaIds: number[];
  outcome: SeasonDeletionOutcome | 'blocked';
  sonarrInstanceId: number | null;
  reason: string | null;
}

export interface SeasonDeletionPreviewResponse {
  seasonRatingKey: string;
  completeEpisodeCount: number;
  selectedEpisodeCount: number;
  selectedVersionCount: number;
  plexOnlyCount: number;
  automaticAdoptionCount: number;
  blockers: string[];
  members: SeasonDeletionMemberPreview[];
  sonarrAvailable: boolean;
  sonarrConfigured: boolean;
  cleanupConfigured: boolean;
  cleanupEligibleVersionCount: number;
  cleanupReason: string | null;
  fingerprint: string;
  expiresAt: number;
}
