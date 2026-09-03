import { formatKilobytes } from "../lib/format.ts";

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

export function isRelocationGuidanceActive(target: {
  status: string;
  phase: string;
  relocationGuidanceState: "none" | "valid" | "invalid";
  relocationSyncBarrierState: "none" | "incomplete" | "completed" | "invalid";
}): boolean {
  return target.status === "needs_attention" && target.phase === "validating" &&
    target.relocationGuidanceState === "valid" && target.relocationSyncBarrierState === "none";
}

export function nonSupersededCancelledCount(
  cancelledCount: number,
  supersededCount: number,
): number {
  return Math.max(0, cancelledCount - supersededCount);
}

export function deletionAttentionSummary(
  removalConfirmedCount: number,
  failedCount: number,
): string {
  return `${removalConfirmedCount} removed · ${failedCount} need attention`;
}

export function deletionWarningSummary(
  removalConfirmedCount: number,
  warningCount: number,
): string {
  return removalConfirmedCount === 0
    ? "No Plex media removal was confirmed"
    : `${removalConfirmedCount} removed · ${warningCount} warning`;
}

export function hardlinkOutcomeSummary(outcome: {
  verifiedHardlinkDataRemoved?: number;
  verifiedTargetCount?: number;
  unknownTargetCount?: number;
  mixedTargetCount?: number;
}): string | null {
  const verifiedTargets = (outcome.verifiedTargetCount ?? 0) +
    (outcome.mixedTargetCount ?? 0);
  const uncertainTargets = (outcome.unknownTargetCount ?? 0) +
    (outcome.mixedTargetCount ?? 0);
  if (verifiedTargets > 0) {
    return `${
      formatKilobytes(outcome.verifiedHardlinkDataRemoved ?? 0)
    } verified hardlink data removed${
      uncertainTargets > 0 ? ` · ${uncertainTargets} targets unknown` : ""
    }`;
  }
  return uncertainTargets > 0 ? "Hardlink data removal not verified" : null;
}

export function noVerifiedDiskSpaceReclaimed(outcome: {
  status: string;
  removalConfirmedCount: number;
  verifiedHardlinkDataRemoved?: number;
  verifiedTargetCount?: number;
  unknownTargetCount?: number;
  mixedTargetCount?: number;
}): boolean {
  return (outcome.status === "completed" || outcome.status === "completed_with_warning") &&
    outcome.removalConfirmedCount > 0 &&
    (outcome.verifiedHardlinkDataRemoved ?? 0) === 0 &&
    (outcome.unknownTargetCount ?? 0) > 0 &&
    (outcome.verifiedTargetCount ?? 0) === 0 &&
    (outcome.mixedTargetCount ?? 0) === 0;
}

const storageOutcomeReasonCopy: Readonly<Record<string, string>> = {
  cleanup_unselected: "Verified hardlink cleanup was not selected for this deletion.",
  live_download_job_only:
    "Only a live download job was eligible for cleanup; no historical hardlink removal was verified.",
  incomplete_two_link_proof:
    "Plex Librarian could not establish and confirm the required two-link hardlink identity.",
  ambiguous_sonarr_instance:
    "More than one Sonarr instance matched this media, so historical hardlink cleanup was not authorized.",
  unlink_confirmation_missing:
    "Hardlink removal may have started, but completion was not confirmed after an interruption.",
};

export function storageOutcomeExplanations(
  targets: ReadonlyArray<{ storageOutcomeReasons?: readonly string[] }>,
): string[] {
  const explanations = new Set<string>();
  for (const target of targets) {
    for (const reason of target.storageOutcomeReasons ?? []) {
      explanations.add(
        storageOutcomeReasonCopy[reason] ??
          "Plex Librarian could not verify storage reclamation for at least one target.",
      );
    }
  }
  return [...explanations];
}

export function retryableRelocationSafeTargetCount(
  targets: ReadonlyArray<{
    status: string;
    phase: string;
    relocationGuidanceState: "none" | "valid" | "invalid";
    relocationSyncBarrierState: "none" | "incomplete" | "completed" | "invalid";
  }>,
  status: "needs_attention" | "completed_with_warning",
): number {
  return targets.filter((target) =>
    target.status === status && target.relocationGuidanceState === "none" &&
    target.relocationSyncBarrierState === "none" &&
    (status !== "completed_with_warning" || target.phase !== "finalizing")
  ).length;
}
