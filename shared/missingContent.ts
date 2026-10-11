export type MissingEvidenceLimitation =
  | 'path_comparison_unavailable'
  | 'plex_paths_incomplete'
  | 'movie_ids_missing';
export type MissingDiagnosisCode =
  | 'radarr_file_incomplete'
  | 'too_many_matches'
  | 'multiple_matches'
  | 'metadata_conflict'
  | 'metadata_ids_missing'
  | 'copy_unverified'
  | 'import_pending'
  | 'import_recent'
  | 'import_time_unknown'
  | 'evidence_incomplete'
  | 'missing_from_plex';
export interface MissingDiagnosis {
  code: MissingDiagnosisCode;
  limitations?: MissingEvidenceLimitation[];
}

export const missingFindingLabels = {
  missing: 'Missing from expected Plex catalog',
  metadata: 'Metadata disagreement',
  version: 'Expected managed version not verified',
  unable: 'Unable to verify',
} as const;
export interface MissingContentResponse {
  rows: Array<{
    instanceId: number;
    libraryKey: string;
    movieId: number;
    posterUrl?: string;
    type: keyof typeof missingFindingLabels;
    title: string;
    firstSeen: number;
    lastSeen: number;
    stale: boolean;
    dismissed: boolean;
    evidence: {
      reason: string;
      /** Older saved audits predate structured diagnoses. */
      diagnosis?: MissingDiagnosis;
      auditedAt: number;
      comparablePath: string | null;
      pending: boolean;
      movie: {
        id: number;
        title: string;
        year: number | null;
        slug: string;
        tmdb: string | null;
        imdb: string | null;
        fileId: number | null;
        path: string | null;
        importedAt: number | null;
      };
      matches: Array<
        {
          ratingKey: string;
          title: string;
          tmdb: string[];
          imdb: string[];
          paths: string[];
          exact: boolean;
        }
      >;
    };
  }>;
  total: number;
  counts: Record<keyof typeof missingFindingLabels, number>;
  setup: {
    plexConnected: boolean;
    unmappedInstances: Array<{ id: number; name: string }>;
    fileComparisonUnavailable: Array<{ instanceId: number; libraryKey: string }>;
  };
  scopes: Array<
    {
      instanceId: number;
      libraryKey: string;
      status: string;
      attemptedAt: number | null;
      completedAt: number | null;
      reason: string | null;
    }
  >;
  instances: Array<{ id: number; name: string }>;
  libraries: Array<{ key: string; title: string }>;
}
