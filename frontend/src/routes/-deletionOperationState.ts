export const activeDeletionStatuses = new Set([
  "queued",
  "running",
  "waiting_retry",
]);

export function deletionOperationPollInterval(
  status: string | undefined,
  nextRetryAt?: number | null,
): number | false {
  if (!activeDeletionStatuses.has(status ?? "")) return false;
  if (status !== "waiting_retry") return 2_000;
  if (!nextRetryAt) return 10_000;
  return Math.min(10_000, Math.max(250, nextRetryAt * 1000 - Date.now() + 100));
}

export function deletionOperationTitle(status: string): string {
  if (status === "completed") return "Deletion complete";
  if (status === "completed_with_warning") {
    return "Media removed; Plex metadata needs attention";
  }
  if (status === "needs_attention") return "Deletion needs attention";
  if (status === "cancelled") return "Deletion cancelled";
  if (status === "waiting_retry") return "Waiting to retry";
  return "Deleting media";
}
