export const activeDeletionStatuses = new Set([
  "queued",
  "running",
  "waiting_retry",
]);

export function deletionOperationPollInterval(
  status: string | undefined,
): 2000 | false {
  return activeDeletionStatuses.has(status ?? "") ? 2000 : false;
}

export function deletionOperationTitle(status: string): string {
  if (status === "completed") return "Deletion complete";
  if (status === "needs_attention") return "Deletion needs attention";
  if (status === "cancelled") return "Deletion cancelled";
  if (status === "waiting_retry") return "Waiting to retry";
  return "Deleting media";
}
