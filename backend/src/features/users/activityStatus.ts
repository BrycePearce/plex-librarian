import type { UserActivityStatus } from '@plex-librarian/shared/types.ts';

export function userHistoryIsComplete(
  usersSyncedAt: number | null,
  videoLibraryHistory: Array<{ historySyncedAt: number | null }>,
): boolean {
  return usersSyncedAt !== null &&
    videoLibraryHistory.every((library) =>
      library.historySyncedAt !== null && library.historySyncedAt >= usersSyncedAt
    );
}

export function userHistoryCanBeAttributed(
  historyComplete: boolean,
  localAccountId: number | null,
): boolean {
  return historyComplete && localAccountId !== null;
}

// A null timestamp only means "never" after both halves of attribution are trustworthy:
// Plex has confirmed a PMS SystemAccount id for this roster user, and every video
// library's cross-user history walk is at least as new as that identity snapshot. Keep
// the two incomplete causes distinct for the UI. An observed play remains authoritative
// when identity reconciliation has not changed its confirmed mapping.
export function userActivityStatus(
  lastViewedAt: number | null,
  localAccountId: number | null,
  historyComplete: boolean,
): UserActivityStatus {
  if (lastViewedAt !== null) return 'watched';
  if (!historyComplete) return 'history_pending';
  return userHistoryCanBeAttributed(historyComplete, localAccountId)
    ? 'never'
    : 'identity_unresolved';
}
