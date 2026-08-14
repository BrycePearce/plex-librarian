import type { MediaVersion } from './versions.ts';
import type { DuplicateSeasonComparisonSummary } from '../../mediaComparison.ts';

export interface DuplicateMovieGroup {
  mediaType: 'movie';
  libraryKey: string;
  ratingKey: string;
  title: string;
  year: number | null;
  thumb: string | null;
  combinedFileSize: number | null;
  versions: MediaVersion[];
}

export interface DuplicateEpisodeGroup {
  mediaType: 'episode';
  libraryKey: string;
  episodeRatingKey: string;
  showRatingKey: string;
  seasonRatingKey: string;
  showTitle: string;
  showThumb: string | null;
  seasonIndex: number;
  episodeIndex: number;
  episodeTitle: string;
  combinedFileSize: number | null;
  versions: MediaVersion[];
}

export type DuplicateGroup = DuplicateMovieGroup | DuplicateEpisodeGroup;

export interface DuplicateSeasonGroup {
  mediaType: 'season';
  libraryKey: string;
  showRatingKey: string;
  seasonRatingKey: string;
  showTitle: string;
  showThumb: string | null;
  seasonIndex: number;
  /** Total eligible duplicate episodes represented by this season row. */
  duplicateGroupCount: number;
  combinedFileSize: number | null;
  comparisonSummary: DuplicateSeasonComparisonSummary;
  episodes: DuplicateEpisodeGroup[];
}

export type DuplicateListGroup = DuplicateMovieGroup | DuplicateSeasonGroup;

export interface DuplicatesResponse {
  search: string;
  limit: number;
  offset: number;
  /** Number of paginated movie/season entries after filtering. */
  total: number;
  /** Number of atomic movie/episode duplicate groups represented by those entries. */
  duplicateGroupTotal: number;
  groups: DuplicateListGroup[];
}
