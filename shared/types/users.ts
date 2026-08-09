export interface PlexUser {
  accountId: number;
  username: string;
  email: string | null;
  thumb: string | null;
  isOwner: boolean;
  lastViewedAt: number | null;
  activityStatus: UserActivityStatus;
  sharingRisk: SharingRiskAssessment;
  requestFollowThrough: RequestFollowThroughAssessment;
}

export type RequestFollowThroughStatus =
  | 'unavailable'
  | 'insufficient_data'
  | 'healthy'
  | 'watch'
  | 'review';

export type RequestFollowThroughReasonType =
  | 'no_seerr_connection'
  | 'seerr_not_synced'
  | 'seerr_sync_error'
  | 'plex_history_incomplete'
  | 'minimum_not_met'
  | 'grace_period_exclusions'
  | 'availability_estimated'
  | 'media_not_matched'
  | 'request_scope_unknown'
  | 'followed_through'
  | 'not_watched'
  | 'habit_assessment';

export interface RequestFollowThroughReason {
  type: RequestFollowThroughReasonType;
  summary: string;
}

export interface RequestFollowThroughAssessment {
  status: RequestFollowThroughStatus;
  eligibleRequestCount: number;
  watchedRequestCount: number | null;
  unwatchedRequestCount: number | null;
  nonWatchPercent: number | null;
  recentRequestCount: number;
  uncertainAvailabilityOutcomeCount: number;
  unmatchedMediaRequestCount: number;
  unknownRequestScopeCount: number;
  graceDays: number;
  minimumRequests: number;
  windowDays: number;
  reasons: RequestFollowThroughReason[];
}

export type UserActivityStatus =
  | 'watched'
  | 'never'
  | 'history_pending'
  | 'identity_unresolved';

export type SharingDataConfidence = 'none' | 'low' | 'medium' | 'high';
export type SharingRiskLevel = 'insufficient_data' | 'low' | 'watch' | 'review';
export type SharingRiskSignalType =
  | 'remote_network_diversity'
  | 'remote_device_diversity'
  | 'rapid_network_switching'
  | 'concurrent_remote_playback';

export interface SharingRiskSignal {
  type: SharingRiskSignalType;
  weight: number;
  summary: string;
}

export interface SharingRiskAssessment {
  // Deterministic review score, not a probability that sharing occurred.
  riskScore: number;
  riskLevel: SharingRiskLevel;
  dataConfidence: SharingDataConfidence;
  observationCount: number;
  activeDays: number;
  observationSpanDays: number;
  observedSince: number | null;
  signals: SharingRiskSignal[];
}

export interface SessionMonitorHealth {
  status: 'starting' | 'connected' | 'polling' | 'disconnected';
  lastSnapshotAt: number | null;
  lastObservationAt: number | null;
  activeSessionCount: number;
  message: string | null;
}

export type UsersActivityFilter = 'all' | 'inactive' | 'never' | 'unknown';
export type UsersRiskFilter = 'all' | 'attention' | SharingRiskLevel;
export type UsersSortKey = 'username' | 'lastViewedAt' | 'sharingRisk';

export interface UsersResponse {
  usersSyncedAt: number | null;
  historyComplete: boolean;
  requestFollowThroughAvailable: boolean;
  inactiveDays: number;
  defaultInactiveDays: number;
  search: string;
  risk: UsersRiskFilter;
  sort: UsersSortKey;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
  total: number;
  monitor: SessionMonitorHealth;
  users: PlexUser[];
}

export interface RemoveUserResponse {
  accountId: number;
  username: string;
}

export interface PendingInvitation {
  inviteId: number;
  username: string | null;
  email: string | null;
  thumb: string | null;
  createdAt: number;
  libraryCount: number | null;
  ageStatus: 'current' | 'stale' | 'critical';
}

export interface PendingInvitationsResponse {
  staleAfterDays: number;
  criticalAfterDays: number;
  serverMatch: 'matched' | 'ambiguous' | 'unavailable';
  overallTotal: number;
  total: number;
  staleCount: number;
  criticalCount: number;
  filter: 'all' | 'attention' | 'current' | 'stale' | 'critical';
  search: string;
  sort: 'createdAt' | 'username' | 'libraryCount';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
  invitations: PendingInvitation[];
}

export interface CancelPendingInvitationResponse {
  inviteId: number;
}
