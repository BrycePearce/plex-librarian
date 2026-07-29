import type { StaleQuickCleanupCandidate } from '@plex-librarian/shared/types.ts';

export const STALE_QUICK_CLEANUP_DEFAULT_DAYS = 730;
export const STALE_QUICK_CLEANUP_MIN_DAYS = 180;
export const STALE_QUICK_CLEANUP_MAX_DAYS = 3_650;
export const STALE_QUICK_CLEANUP_LIMIT = 200;

export function classifyStaleQuickCleanup(
  lastViewedAt: number | null,
  addedAt: number | null,
  cutoff: number,
): StaleQuickCleanupCandidate['reason'] | null {
  if (lastViewedAt !== null) return lastViewedAt < cutoff ? 'long-dormant' : null;
  return addedAt !== null && addedAt < cutoff ? 'never-watched' : null;
}

export function parseStaleQuickCleanupDays(value: unknown): number | null {
  const days = Number(value);
  return Number.isInteger(days) &&
      days >= STALE_QUICK_CLEANUP_MIN_DAYS &&
      days <= STALE_QUICK_CLEANUP_MAX_DAYS
    ? days
    : null;
}
