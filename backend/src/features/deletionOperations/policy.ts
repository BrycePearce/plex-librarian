export function isRetryableDeletionFailure(
  status: number | null,
  message: string,
  transportFailure = false,
): boolean {
  const embeddedStatus = message.match(/\b(?:Plex|Radarr|Sonarr|qBittorrent)\s+(\d{3})\b/i);
  const effectiveStatus = embeddedStatus ? Number(embeddedStatus[1]) : status;
  if (
    effectiveStatus === 408 || effectiveStatus === 429 ||
    (effectiveStatus !== null && effectiveStatus >= 500)
  ) return true;
  if (effectiveStatus !== null && effectiveStatus >= 400) return false;
  if (transportFailure) return true;
  return /\b(timeout|timed out|network|connection|temporar|unavailable|fetch failed)\b/i.test(
    message,
  );
}
