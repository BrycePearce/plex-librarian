export interface StaleCutoffs {
  viewedBefore: number;
  viewedOnOrAfter: number | null;
  unwatchedAddedBefore: number;
  unwatchedAddedOnOrAfter: number | null;
}

/** Builds the time boundaries for the stale-item query. */
export function staleCutoffs(
  now: number,
  days: number,
  maxDays: number | null,
  minAgeDays: number,
): StaleCutoffs {
  const secondsPerDay = 86_400;
  return {
    viewedBefore: now - days * secondsPerDay,
    viewedOnOrAfter: maxDays === null ? null : now - maxDays * secondsPerDay,
    // Never-watched inactivity starts when the item was added. The minimum age is
    // an additional safety floor, so the stricter of the two requirements wins.
    unwatchedAddedBefore: now - Math.max(days, minAgeDays) * secondsPerDay,
    unwatchedAddedOnOrAfter: maxDays === null ? null : now - maxDays * secondsPerDay,
  };
}
