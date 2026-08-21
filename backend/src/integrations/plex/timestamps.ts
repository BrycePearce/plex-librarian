const DAY_SECONDS = 86_400;

// Plex timestamps are Unix seconds. A bare calendar year is numerically valid but
// represents a date near the Unix epoch, so retain a generous pre-Plex buffer while
// rejecting year-shaped values and milliseconds/far-future values.
export const EARLIEST_PLAUSIBLE_PLEX_TIMESTAMP = 946_684_800; // 2000-01-01 UTC

export function plausiblePlexTimestamp(value: unknown, now: number): value is number {
  return value !== null && value !== undefined && Number.isSafeInteger(value) &&
    (value as number) >= EARLIEST_PLAUSIBLE_PLEX_TIMESTAMP &&
    (value as number) <= now + DAY_SECONDS;
}

export function normalizePlexTimestamp(
  value: unknown,
  now = Math.floor(Date.now() / 1000),
): number | null {
  return plausiblePlexTimestamp(value, now) ? value : null;
}
