export interface DeletionRecoveryGuidance {
  title: string;
  steps: string[];
}

interface RecoveryTargetState {
  error: string | null;
  phase: string;
  resolutionState?: string;
  relocationGuidanceState?: "none" | "valid" | "invalid";
  relocationSyncBarrierState?: "none" | "incomplete" | "completed" | "invalid";
}

function includesAny(value: string, fragments: readonly string[]): boolean {
  return fragments.some((fragment) => value.includes(fragment));
}

export function deletionRecoveryGuidance(
  target: RecoveryTargetState,
): DeletionRecoveryGuidance {
  const error = target.error?.toLowerCase() ?? "";

  if (target.resolutionState === "management_hold") {
    return {
      title: "Repair the reserved Radarr movie",
      steps: [
        "Restore Radarr to the retained target path and file shown below, or restore its exact original path and file.",
        "Choose Verify repaired Radarr state. Plex Librarian will inspect both services before continuing.",
      ],
    };
  }
  if (
    target.relocationGuidanceState === "valid" &&
    target.relocationSyncBarrierState === "none"
  ) {
    return {
      title: "Move the retained version into Radarr's managed location",
      steps: [
        "Follow the retained-version relocation instructions below.",
        "Confirm playback from the destination, then let Plex Librarian sync and finish recovery.",
      ],
    };
  }
  if (
    target.relocationGuidanceState !== undefined &&
    (target.relocationGuidanceState !== "none" ||
      target.relocationSyncBarrierState !== "none")
  ) {
    return {
      title: "Continue the recovery workflow",
      steps: ["Use the recovery workflow below to finish the required repair or sync."],
    };
  }
  if (
    includesAny(error, [
      "no visible retained plex version",
      "no retained plex version inside",
      "cannot safely adopt the retained plex version",
      "retained_parent_mismatch",
    ])
  ) {
    return {
      title: "Make the retained file visible to Radarr",
      steps: [
        "In Radarr, confirm the movie path contains the copy you intend to keep and no competing video file.",
        "Move/import the retained Plex file into that folder, or update Radarr's movie path, then run a Radarr refresh/rescan.",
        "Choose Recheck. Dismiss only if you completed the repair manually and no further coordinated cleanup is needed.",
      ],
    };
  }
  if (
    includesAny(error, [
      "source disappeared before arr ownership was persisted",
      "source disappeared",
      "target disappeared",
    ])
  ) {
    return {
      title: "Verify the manual deletion in both services",
      steps: [
        "Confirm Plex has the intended retained version and Radarr points to that same file.",
        "Run Plex and Radarr scans if either service is stale, then choose Recheck.",
        "If both are already correct, Dismiss releases the recovery lock while preserving this warning.",
      ],
    };
  }
  if (target.phase === "plex_reconciliation") {
    return {
      title: "Refresh Plex metadata",
      steps: [
        "Scan the Plex library and empty its trash if appropriate. Plex Librarian will recheck after its next successful sync.",
        "Choose Recheck to try again now.",
        "Dismiss only after confirming the removed file is gone and the intended retained media still plays.",
      ],
    };
  }
  if (includesAny(error, ["mapping", "path changed", "ownership", "identity"])) {
    return {
      title: "Correct the integration mapping",
      steps: [
        "Check the Plex-to-container and Sonarr/Radarr path mappings in Settings.",
        "Sync the affected library, then choose Recheck so identities and paths are validated again.",
      ],
    };
  }
  if (includesAny(error, ["unreachable", "timed out", "rate limit", "connection"])) {
    return {
      title: "Restore the service connection",
      steps: [
        "Confirm Plex, Sonarr/Radarr, and any configured download client are reachable.",
        "Choose Recheck after connectivity is restored.",
      ],
    };
  }
  return {
    title: "Inspect and recheck the target",
    steps: [
      "Open the operation to see which validation or service failed, correct that state, then choose Recheck.",
      "If you resolved it outside Plex Librarian, verify the retained media and use Dismiss to release recovery state.",
    ],
  };
}

export function deletionRecoverySummary(
  failureReasons: readonly string[],
  status?: string,
): string {
  if (status === "completed_with_warning") {
    return "Scan the Plex library. Plex Librarian will recheck after the next successful sync.";
  }
  return deletionRecoveryGuidance({
    error: failureReasons[0] ?? null,
    phase: "validating",
  }).steps[0];
}
