import type { DuplicateEpisodeGroup } from './duplicates.ts';
import type { DeletionOperationStatus } from '../deletion/operations.ts';

export interface SeasonVersionProfileMember {
  episodeRatingKey: string;
  mediaId: number;
  /** Ephemeral Plex path evidence used to verify the inferred season lane. */
  filePath?: string | null;
}

export type SeasonLaneMatchBasis =
  | 'release-root'
  | 'filename-family'
  | 'technical-only'
  | 'mixed';

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
  /** The fixed evidence that made this lane selectable. */
  matchBasis: SeasonLaneMatchBasis;
  members: SeasonVersionProfileMember[];
  /** Exact members currently owned by Sonarr's EpisodeFile records. */
  sonarrManagedCount?: number;
  /** Exact members covered by a verified live qBittorrent payload. */
  qbittorrentSeededCount?: number;
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
  connections?: {
    sonarr: boolean;
    qbittorrent: boolean;
  };
  episodes: DuplicateEpisodeGroup[];
  uncertainEpisodeRatingKeys: string[];
}

export type SeasonDeletionOutcome =
  | 'plex_only'
  | 'automatic_adoption'
  | 'removed_and_unmonitored';

export type SeasonSonarrMode =
  | 'none'
  | 'adopt_retained'
  | 'remove_and_unmonitor';

export interface SeasonDeletionSelection {
  episodeRatingKey: string;
  mediaIds: number[];
}

export interface SeasonDeletionIntent {
  selections: SeasonDeletionSelection[];
  sonarrMode: SeasonSonarrMode;
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
  removedAndUnmonitoredCount?: number;
  blockers: string[];
  members: SeasonDeletionMemberPreview[];
  sonarrAvailable: boolean;
  sonarrConfigured: boolean;
  sonarrInspectionWarning?: string | null;
  sonarrAdoptionTargets?: Array<{
    episodeRatingKey: string;
    episodeTitle: string;
    mediaId: number;
    path: string;
    fallbackCandidateCount: number;
  }>;
  cleanupConfigured: boolean;
  cleanupEligibleVersionCount: number;
  cleanupReason: string | null;
  adoptionUnavailableReason?: string | null;
  breakGlassAvailable?: boolean;
  fingerprint: string;
  expiresAt: number;
}
