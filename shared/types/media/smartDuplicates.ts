import type { MediaVersion } from './versions.ts';

export type SmartDuplicateConfidence = 'obvious' | 'near-identical' | 'review';

export interface SmartDuplicateCandidate {
  mediaType: 'movie' | 'episode';
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

export interface SmartDuplicateAnalysisResponse {
  analyzedGroups: number;
  protectedGroups: number;
  candidates: SmartDuplicateCandidate[];
}

export interface SmartDuplicateCleanupResponse {
  operationIds: string[];
  targetCount: number;
}
