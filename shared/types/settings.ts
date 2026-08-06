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
