import type { HistoricalAccessStatus } from "../../../../shared/historicalDownloads.ts";
export interface HistoricalNoticeSnapshot {
  serverId: number | null;
  problems: ReadonlySet<string>;
}

export function historicalCheckMessage(statuses: readonly HistoricalAccessStatus[]) {
  if (!statuses.length) return "No access result is available for this server.";
  return statuses.map((s) =>
    `${s.configuration.remoteRoot}: ${s.status.replaceAll("_", " ")}${
      s.reason ? `. ${s.reason}` : "."
    }`
  ).join(" ");
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
