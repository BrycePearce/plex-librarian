import type { EpisodeGapsResponse, EpisodeGapsScope } from "@shared/types";

export function episodeGapsSummaryPresentation(
  data: EpisodeGapsResponse | undefined,
  scope: EpisodeGapsScope,
) {
  const seasonScope = scope === "season";
  return {
    missingCount: data
      ? data.scope === "episode"
        ? data.summary.missingEpisodeCount
        : data.summary.missingSeasonCount
      : undefined,
    gapContainerCount: data
      ? data.scope === "episode" ? data.summary.gapSeasonCount : data.summary.gapShowCount
      : undefined,
    irregularCount: data
      ? data.scope === "episode"
        ? data.summary.irregularSeasonCount
        : data.summary.irregularShowCount
      : undefined,
    missingNoun: seasonScope ? "seasons" : "episodes",
    containerNoun: seasonScope ? "shows" : "seasons",
    irregularNoun: seasonScope ? "shows" : "seasons",
  };
}
