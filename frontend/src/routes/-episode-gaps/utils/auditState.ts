import type { EpisodeGapsResponse } from "@shared/types";

/** Keeps retained findings visible while a replacement audit is incomplete. */
export function hasRetainedEpisodeAuditFindings(data: EpisodeGapsResponse): boolean {
  return data.rows.length > 0 || data.summary.gapSeasonCount > 0 ||
    data.summary.irregularSeasonCount > 0;
}

export function isEpisodeAuditUninitialized(data: EpisodeGapsResponse): boolean {
  // Null confidence retains stale findings after interrupted and in-progress syncs. Those
  // findings remain useful and must not be replaced by the first-audit empty state.
  return data.libraryAudits.length > 0 && !hasRetainedEpisodeAuditFindings(data) &&
    data.libraryAudits.every((audit) => audit.episodeAuditSyncedAt === null);
}
