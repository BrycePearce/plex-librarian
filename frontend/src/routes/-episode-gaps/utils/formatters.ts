export function episodeGapReasonLabel(reason: string | null): string {
  return reason === "episode_index_too_large"
    ? "Episode indexes exceed the safe audit range."
    : reason === "invalid_season_index"
    ? "Plex returned an invalid season index."
    : reason === "season_index_too_large"
    ? "The season index exceeds the safe audit range."
    : reason === "range_limit_exceeded"
    ? "Numbering is too fragmented for a trustworthy result."
    : reason === "conflicting_season_identity"
    ? "Plex returned conflicting season identity."
    : reason === "invalid_projection"
    ? "Saved audit data could not be validated."
    : "One or more episodes has an invalid index.";
}

export function formatEpisodeAuditTime(epoch: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    epoch * 1000,
  );
}
