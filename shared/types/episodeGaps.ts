export type EpisodeGapsStatusFilter = 'gaps' | 'irregular' | 'all';
export type EpisodeGapsSort = 'missingCount' | 'title' | 'seasonIndex' | 'auditSyncedAt';
export type SortOrder = 'asc' | 'desc';

export interface EpisodeGapRange {
  start: number;
  end: number;
}

export interface EpisodeGapSeason {
  libraryKey: string;
  libraryTitle: string;
  showRatingKey: string;
  showTitle: string;
  showThumb: string | null;
  seasonRatingKey: string;
  seasonIndex: number;
  seasonTitle: string;
  firstEpisodeIndex: number | null;
  lastEpisodeIndex: number | null;
  presentCount: number;
  missingCount: number;
  missingRanges: EpisodeGapRange[];
  status: 'gaps' | 'irregular' | 'ok';
  reason: string | null;
  episodeAuditSyncedAt: number | null;
}

export interface EpisodeGapsResponse {
  summary: {
    gapSeasonCount: number;
    missingEpisodeCount: number;
    checkedLibraryCount: number;
    irregularSeasonCount: number;
  };
  total: number;
  limit: number;
  offset: number;
  libraryAudits: Array<{
    libraryKey: string;
    libraryTitle: string;
    episodeAuditSyncedAt: number | null;
  }>;
  rows: EpisodeGapSeason[];
}

export interface EpisodeGapsParams {
  libraryKey?: string;
  status?: EpisodeGapsStatusFilter;
  search?: string;
  sort?: EpisodeGapsSort;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}
