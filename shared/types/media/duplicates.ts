import type { MediaVersion } from './versions.ts';

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
  showTitle: string;
  showThumb: string | null;
  seasonIndex: number;
  episodeIndex: number;
  episodeTitle: string;
  combinedFileSize: number | null;
  versions: MediaVersion[];
}

export type DuplicateGroup = DuplicateMovieGroup | DuplicateEpisodeGroup;

export interface DuplicatesResponse {
  search: string;
  limit: number;
  offset: number;
  total: number;
  groups: DuplicateGroup[];
}
