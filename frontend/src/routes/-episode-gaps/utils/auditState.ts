import type {
  EpisodeGapsPageResponse,
  EpisodeGapsResponse,
  EpisodeGapsSummaryResponse,
} from "@shared/types";

function matchingSummary(
  data: EpisodeGapsPageResponse,
  summary: EpisodeGapsSummaryResponse | undefined,
): EpisodeGapsSummaryResponse | undefined {
  return summary?.scope === data.scope ? summary : undefined;
}

function combinedSummary(data: EpisodeGapsPageResponse): EpisodeGapsSummaryResponse | undefined {
  return "summary" in data ? data as EpisodeGapsResponse : undefined;
}

/** Keeps retained findings visible while a replacement audit is incomplete. */
export function hasRetainedEpisodeAuditFindings(
  data: EpisodeGapsPageResponse,
  summary: EpisodeGapsSummaryResponse | undefined = combinedSummary(data),
): boolean {
  const current = matchingSummary(data, summary);
  return data.rows.length > 0 || Boolean(
    current &&
      (current.scope === "episode"
        ? current.summary.gapSeasonCount > 0 || current.summary.irregularSeasonCount > 0
        : current.summary.gapShowCount > 0 || current.summary.irregularShowCount > 0),
  );
}

/** Empty retained pages need totals before null audit markers can mean first-run. */
export function needsEpisodeAuditSummary(
  data: EpisodeGapsPageResponse,
  summary: EpisodeGapsSummaryResponse | undefined,
): boolean {
  return data.rows.length === 0 && !matchingSummary(data, summary) &&
    data.libraryAudits.length > 0 &&
    data.libraryAudits.every((audit) => audit.episodeAuditSyncedAt === null);
}

export function isEpisodeAuditUninitialized(
  data: EpisodeGapsPageResponse,
  summary: EpisodeGapsSummaryResponse | undefined = combinedSummary(data),
): boolean {
  // Null confidence retains stale findings after interrupted and in-progress syncs. Those
  // findings remain useful and must not be replaced by the first-audit empty state.
  return Boolean(matchingSummary(data, summary)) && data.libraryAudits.length > 0 &&
    !hasRetainedEpisodeAuditFindings(data, summary) &&
    data.libraryAudits.every((audit) => audit.episodeAuditSyncedAt === null);
}
