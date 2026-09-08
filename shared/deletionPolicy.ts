/** Explicit scope boundary; absent or unknown versions must never execute as this policy. */
export const CURRENT_LOCATION_POLICY_VERSION = 2;

/** Optional destinations require an explicit choice for each new selection. */
export const OPTIONAL_DELETION_DESTINATIONS = {
  arr: false,
  qbittorrent: false,
} as const;
