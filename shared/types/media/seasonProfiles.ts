import type { DuplicateEpisodeGroup } from './duplicates.ts';

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
  omittedEpisodeCount: number;
  recommendedProfileId: string | null;
  profiles: SeasonVersionProfile[];
  episodes: DuplicateEpisodeGroup[];
  uncertainEpisodeRatingKeys: string[];
  /** Authorizes only a fresh server-side reconstruction of these exact episode/media rows. */
  analysisFingerprint: string;
  expiresAt: number;
}

export type SeasonDeletionOutcome =
  | 'plex_only'
  | 'automatic_adoption';

export interface SeasonDeletionSelection {
  episodeRatingKey: string;
  mediaIds: number[];
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
  fingerprint: string;
  expiresAt: number;
}
