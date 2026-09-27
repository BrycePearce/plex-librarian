import type { UsersActivityFilter, UsersRiskFilter, UsersSortKey } from "@shared/types";

export type {
  ActivityEvent,
  ActivityEventsResponse,
  ArrCleanupFile,
  ArrCleanupTarget,
  ArrInstance,
  ArrIntegrationSettings,
  ArrLibraryMapping,
  ArrRootFoldersRequest,
  ArrRootFoldersResponse,
  ArrType,
  AuthStatus,
  CancelPendingInvitationResponse,
  DeleteItemsResponse,
  DeletionOperation,
  DeletionOperationCreated,
  DeletionOperationListItem,
  DeletionOperationsResponse,
  DownloadCleanupJob,
  DownloadCleanupPreviewItem,
  DownloadCleanupPreviewResponse,
  DuplicateEpisodeGroup,
  DuplicateGroup,
  DuplicateListGroup,
  DuplicateMovieGroup,
  DuplicateSeasonGroup,
  DuplicatesResponse,
  EpisodeGapSeason,
  EpisodeGapsParams,
  EpisodeGapsResponse,
  EventType,
  LibrariesResponse,
  Library,
  LibraryPhase,
  LibrarySyncProgress,
  MediaRemovalSummary,
  MediaVersion,
  MediaVersionPathPreview,
  MovieDetail,
  PendingInvitation,
  PendingInvitationsResponse,
  PinPollResult,
  PlexConnection,
  PlexPin,
  PlexServer,
  PlexUser,
  QbittorrentInstance,
  QbittorrentIntegrationSettings,
  QbittorrentPathMapping,
  QbittorrentStoragePathsResponse,
  RemoveUserResponse,
  RequestFollowThroughDetailItem,
  RequestFollowThroughDetailsResponse,
  Season,
  SeasonDeletionPreviewResponse,
  SeasonVersionAnalysisResponse,
  SeasonVersionProfile,
  SeerrInstance,
  SeerrIntegrationSettings,
  Settings,
  SharingRiskTrendPoint,
  SharingRiskTrendResponse,
  ShowDetail,
  SmartDuplicateAnalysisResponse,
  SmartDuplicateCandidate,
  SmartDuplicateCleanupResponse,
  SmartDuplicateEpisodeCandidate,
  StaleItem,
  StaleQuickCleanupCandidate,
  StaleQuickCleanupOrder,
  StaleQuickCleanupResponse,
  StaleQuickCleanupSort,
  StaleResponse,
  SyncLog,
  SyncTriggerResponse,
  UsersActivityFilter,
  UsersResponse,
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
