import type { MediaVersion } from './media/versions.ts';

export interface Library {
  key: string;
  title: string;
  type: string;
  syncedAt: number;
  // Null until the cross-user play-history backfill completes for the current sync.
  historySyncedAt: number | null;
  staleMinAgeDays: number | null;
  itemCount: number;
  // Decimal KB, matching StaleItem.fileSize.
  totalFileSize: number;
}

export interface LibrariesResponse {
  limit: number;
  offset: number;
  total: number;
  libraries: Library[];
}

export interface StaleItem {
  ratingKey: string;
  libraryKey: string;
  title: string;
  type: string;
  thumb: string | null;
  addedAt: number | null;
  lastViewedAt: number | null;
  viewCount: number | null;
  fileSize: number | null;
  duration: number | null;
  year: number | null;
  updatedAt: number;
  // Present for stale movie items with multiple synced Plex Media versions.
  versions?: MediaVersion[];
  // Present when at least one episode in a stale show has multiple versions.
  hasDuplicateEpisodes?: boolean;
}

export interface StaleResponse {
  days: number;
  maxDays: number | null;
  minAgeDays: number;
  libraryStaleMinAgeDays: number | null;
  historySyncedAt: number | null;
  search: string;
  filter: string;
  sort: string;
  order: string;
  duplicatesOnly: boolean;
  limit: number;
  offset: number;
  // Null only when the caller explicitly requests count=false.
  total: number | null;
  // Derived by fetching one row beyond limit.
  hasMore: boolean;
  items: StaleItem[];
}

export type StaleQuickCleanupReason = 'never-watched' | 'long-dormant';
export type StaleQuickCleanupSort = 'inactiveSince' | 'fileSize';
export type StaleQuickCleanupOrder = 'asc' | 'desc';

export interface StaleQuickCleanupCandidate extends StaleItem {
  reason: StaleQuickCleanupReason;
  inactiveSince: number;
}

export interface StaleQuickCleanupResponse {
  thresholdDays: number;
  historySyncedAt: number | null;
  eligible: boolean;
  unavailableReason: 'history-incomplete' | 'unsupported-library' | null;
  candidateTotal: number;
  candidateFileSize: number;
  unknownSizeCount: number;
  duplicateProtectedCount: number;
  recentRequestProtectedCount: number;
  activePlaybackProtectedCount: number;
  limit: number;
  candidates: StaleQuickCleanupCandidate[];
}

export interface Season {
  ratingKey: string;
  showRatingKey: string;
  libraryKey: string;
  seasonIndex: number;
  title: string;
  fileSize: number | null;
  duration: number | null;
  leafCount: number | null;
  viewCount: number | null;
  updatedAt: number;
}

export interface ShowDetail {
  show: StaleItem;
  seasons: Season[];
  historySyncedAt: number | null;
}

export interface MovieDetail {
  movie: StaleItem;
  historySyncedAt: number | null;
}
