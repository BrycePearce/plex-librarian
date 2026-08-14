import type { MediaVersion } from './versions.ts';

export type SmartDuplicateConfidence = 'obvious' | 'near-identical' | 'review';

interface SmartDuplicateCandidateBase {
  libraryKey: string;
  ratingKey: string;
  title: string;
  context: string | null;
  confidence: SmartDuplicateConfidence;
  keepMediaId: number;
  deleteMediaIds: number[];
  reclaimableSize: number | null;
  reasons: string[];
  versions: MediaVersion[];
}

export interface SmartDuplicateMovieCandidate extends SmartDuplicateCandidateBase {
  mediaType: 'movie';
}

export interface SmartDuplicateEpisodeCandidate extends SmartDuplicateCandidateBase {
  mediaType: 'episode';
  showRatingKey: string;
  seasonRatingKey: string;
  seasonIndex: number;
  episodeIndex: number;
  episodeTitle: string;
}

export type SmartDuplicateCandidate =
  | SmartDuplicateMovieCandidate
  | SmartDuplicateEpisodeCandidate;

export interface SmartDuplicateAnalysisResponse {
  analyzedGroups: number;
  protectedGroups: number;
  candidates: SmartDuplicateCandidate[];
}

export interface SmartDuplicateCleanupResponse {
  operationIds: string[];
  targetCount: number;
}
