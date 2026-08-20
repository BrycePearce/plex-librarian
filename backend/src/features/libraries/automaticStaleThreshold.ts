const DAY_SECONDS = 86_400;
const DAYS_PER_YEAR = 365;

export const STALE_BROWSER_FALLBACK_DAYS = DAYS_PER_YEAR;
export const STALE_QUICK_CLEANUP_FALLBACK_DAYS = 3 * DAYS_PER_YEAR;

const MIN_AUTOMATIC_YEARS = 2;
const MAX_AUTOMATIC_YEARS = 6;
const LIBRARY_YEARS_PER_STALE_YEAR = 3;

export function plausibleItemAddedAt(addedAt: number | null, now: number): boolean {
  // A one-day allowance avoids discarding otherwise valid data because the Plex and
  // app clocks differ slightly. Larger future timestamps are not useful age evidence.
  return addedAt !== null && Number.isSafeInteger(addedAt) && addedAt > 0 &&
    addedAt <= now + DAY_SECONDS;
}

export function automaticStaleThresholdDays(
  oldestItemAddedAt: number | null,
  now: number,
): number {
  if (oldestItemAddedAt === null || !plausibleItemAddedAt(oldestItemAddedAt, now)) {
    return STALE_BROWSER_FALLBACK_DAYS;
  }

  const libraryAgeDays = Math.max(0, Math.floor((now - oldestItemAddedAt) / DAY_SECONDS));
  const suggestedYears = Math.round(
    libraryAgeDays / DAYS_PER_YEAR / LIBRARY_YEARS_PER_STALE_YEAR,
  );
  const boundedYears = Math.max(
    MIN_AUTOMATIC_YEARS,
    Math.min(MAX_AUTOMATIC_YEARS, suggestedYears),
  );
  return boundedYears * DAYS_PER_YEAR;
}

export function automaticQuickCleanupThresholdDays(
  oldestItemAddedAt: number | null,
  now: number,
): number {
  return Math.max(
    STALE_QUICK_CLEANUP_FALLBACK_DAYS,
    automaticStaleThresholdDays(oldestItemAddedAt, now),
  );
}
