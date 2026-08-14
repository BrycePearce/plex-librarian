const PREVIEW_TTL_SECONDS = 5 * 60;

export function seasonDeletionPreviewExpiry(now = Math.floor(Date.now() / 1000)): number {
  return now + PREVIEW_TTL_SECONDS;
}
