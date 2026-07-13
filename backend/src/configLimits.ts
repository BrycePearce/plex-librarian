// Large enough to avoid constraining legitimate cleanup policies while keeping date
// arithmetic and persisted settings within a meaningful human-scale range.
export const MAX_INACTIVITY_DAYS = 36_500;

// Sharing-risk signals use a fixed 30-day window. Retention may be unlimited (0),
// otherwise it must preserve that entire window so the assessment is not partial.
export const MIN_USER_ACTIVITY_RETENTION_DAYS = 30;
