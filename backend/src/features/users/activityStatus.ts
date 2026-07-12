import type { UserActivityStatus } from '@plex-librarian/shared/types.ts';

// A null timestamp only means "never" after both halves of attribution are trustworthy:
// Plex has given us a PMS-local identity for this roster user, and every video library's
// cross-user history walk has completed. An observed play remains authoritative even if
// a later roster refresh temporarily loses the local-id mapping.
export function userActivityStatus(
  lastViewedAt: number | null,
  localAccountId: number | null,
  historyComplete: boolean,
): UserActivityStatus {
  if (lastViewedAt !== null) return 'watched';
  return localAccountId !== null && historyComplete ? 'never' : 'unknown';
}
