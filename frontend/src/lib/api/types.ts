import type { UsersActivityFilter, UsersRiskFilter, UsersSortKey } from "@shared/types";

export type {
  ActivityEvent,
  ArrCleanupTarget,
  ArrInstance,
  ArrIntegrationSettings,
  ArrRootFoldersRequest,
  ArrRootFoldersResponse,
  AuthStatus,
  DownloadCleanupJob,
  DownloadCleanupPreviewItem,
  DuplicateDirectoryGroup,
  DuplicateGroup,
  DuplicateListGroup,
  DuplicateMovieGroup,
  DuplicateSeasonGroup,
  DuplicateSeasonSummaryGroup,
  EventType,
  LibrariesResponse,
  Library,
  LibraryPhase,
  LibrarySyncProgress,
  MediaVersion,
  MediaVersionPathPreview,
  PendingInvitation,
  PlexServer,
  PlexUser,
  QbittorrentInstance,
  RequestFollowThroughDetailItem,
  SeasonVersionProfile,
  SeerrInstance,
  Settings,
  SharingRiskTrendPoint,
  SharingRiskTrendResponse,
  SmartDuplicateAnalysisResponse,
  SmartDuplicateCandidate,
  SmartDuplicateEpisodeCandidate,
  StaleItem,
  SyncLog,
  UsersActivityFilter,
  UsersRiskFilter,
  UsersSortKey,
  VersionDeletionPreviewResponse,
} from "@shared/types";

// Frontend-only types (not part of the API contract)
export type SortKey = "fileSize" | "lastViewedAt" | "addedAt" | "title" | "year" | "viewCount";

export interface StaleParams {
  scope?: "show" | "season";
  days?: number;
  maxDays?: number;
  minAgeDays?: number;
  search?: string;
  filter?: "all" | "watched" | "unwatched";
  duplicatesOnly?: boolean;
  sort?: SortKey;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
  count?: boolean;
}

export interface UsersParams {
  search?: string;
  filter?: UsersActivityFilter;
  inactiveDays?: number;
  risk?: UsersRiskFilter;
  sort?: UsersSortKey;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}
