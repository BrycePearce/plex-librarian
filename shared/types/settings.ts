export interface Settings {
  autoSyncEnabled: boolean;
  autoSyncHour: number;
  autoSyncTimeZone: string;
  autoSyncCatchUp: boolean;
  staleMinAgeDays: number;
  inactiveUserDays: number;
  requestFollowThroughGraceDays: number;
  requestFollowThroughMinRequests: number;
  pendingInviteStaleDays: number;
  pendingInviteCriticalDays: number;
  ipHistoryRetentionDays: number;
}

export interface PlexPathMapping {
  id: number;
  serverId: number;
  libraryKey: string;
  plexPath: string;
  localPath: string;
  caseSensitive: boolean;
  revision: number;
  validationPlexPath: string;
  validationLocalPath: string;
  validationSize: number;
  validatedAt: number;
}

export interface SavePlexPathMappingRequest {
  libraryKey: string;
  plexPath: string;
  localPath: string;
  caseSensitive: boolean;
  sampleRatingKey: string;
  sampleMediaId: number;
}
