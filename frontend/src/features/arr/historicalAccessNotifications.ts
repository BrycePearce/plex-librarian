import type { HistoricalAccessStatus } from "../../../../shared/historicalDownloads.ts";
export interface HistoricalNoticeSnapshot {
  serverId: number | null;
  problems: ReadonlySet<string>;
}

export function historicalCheckMessage(statuses: readonly HistoricalAccessStatus[]) {
  if (!statuses.length) return "No access result is available for this server.";
  return statuses.map(historicalAccessMessage).join(" ");
}

export function historicalAccessMessage(s: HistoricalAccessStatus): string {
  if (s.status === "ready_to_enable") {
    return "Folder relationship and access verified. Enable to include eligible leftover downloads in service deletions.";
  }
  const folder = s.diagnostic?.folder || s.configuration.localRoot ||
    "the configured download folder";
  switch (s.diagnostic?.code) {
    case "missing_root":
      return `Folder ${folder} is missing inside Librarian. Add its host-folder mount in Docker/Unraid, or correct the Librarian path.`;
    case "access_denied":
      return `Cannot access folder ${folder}. Check the container identity and host-folder permissions.`;
    case "read_only":
      return `Folder ${folder} is on a read-only mount. Change that download mount to Read/Write in Docker/Unraid.`;
    case "sample_absent":
      return `Folder ${folder} is accessible, but the old sample file is gone. The mount is not missing; review a current history-linked file to check its folder.`;
    case "invalid_folder":
      return `${folder} is not a folder. Correct the Librarian path to the mounted download folder.`;
    case "timeout":
      return "Folder verification timed out. Check storage availability, then retry Check access.";
    case "unsupported":
      return "Folder verification could not finish. Retry Check access; if it persists, check the Linux container runtime and its /usr/bin/test utility.";
  }
  if (s.status === "available") {
    return `Folder ${folder} passed read-only access checks. Deletion is verified separately.`;
  }
  if (s.status === "checking") return "Checking folder access…";
  if (s.status === "waiting_for_sample") {
    return "Waiting for a history-linked sample. Sync Sonarr data or open a deletion preview, then check access again.";
  }
  if (s.status === "not_enabled") return "Folder access is disabled.";
  if (!s.configuration.localRoot) {
    return "Add the host-folder mount in Docker/Unraid, then enter its matching Librarian path in Edit access.";
  }
  return "Folder access is unverified. Run Check access for a current diagnosis; review Access details if it still fails.";
}

export function historicalAccessNotification(
  previous: HistoricalNoticeSnapshot | undefined,
  serverId: number | null,
  statuses: readonly HistoricalAccessStatus[],
) {
  const problems = new Set(
    statuses.filter((s) => s.configuration.enabled && !!s.problemRevision).map((s) => s.id),
  );
  const recovered = previous?.serverId === serverId && serverId !== null &&
    statuses.some((s) =>
      s.configuration.enabled && s.status === "available" && previous.problems.has(s.id)
    );
  return {
    snapshot: { serverId, problems },
    message: recovered ? "Historical download folder access is available again." : null,
  };
}
