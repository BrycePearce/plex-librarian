import { useState } from "react";
import { ChevronRight, CircleHelp, Layers3 } from "lucide-react";
import type { DuplicateEpisodeGroup, DuplicateSeasonGroup } from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { PosterThumb } from "../../components/PosterThumb.tsx";
import { HoverPopover } from "../../components/HoverPopover.tsx";
import {
  reclaimableKilobytes,
  seasonDifferenceChips,
  seasonSummaryAccessibleText,
} from "./duplicatePresentation.ts";
import { DuplicateGroupRow } from "./DuplicateGroupRow.tsx";

function sumKnown(values: Array<number | null>): number | null {
  return values.every((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : null;
}

export function DuplicateSeasonRows({
  season,
  disabled,
  onReviewSeason,
  onReviewEpisode,
}: {
  season: DuplicateSeasonGroup;
  disabled: boolean;
  onReviewSeason: (season: DuplicateSeasonGroup) => void;
  onReviewEpisode: (episode: DuplicateEpisodeGroup) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const reclaimable = sumKnown(
    season.episodes.map((episode) => reclaimableKilobytes(episode.versions)),
  );
  const reviewedFileSize = sumKnown(season.episodes.map((episode) => episode.combinedFileSize));
  const reclaimablePercent = reclaimable !== null && reviewedFileSize
    ? Math.min(100, Math.max(0, (reclaimable / reviewedFileSize) * 100))
    : 0;
  const partialPass = season.episodes.length < season.duplicateGroupCount;
  const label = `${season.showTitle}, season ${season.seasonIndex}`;
  const summary = season.comparisonSummary;
  const visibleDifferences = seasonDifferenceChips(summary);
  const allDifferences = seasonDifferenceChips(summary, Number.POSITIVE_INFINITY).chips;

  return (
    <>
      <tr
        className={`duplicates-season-row group polished-row focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${
          disabled ? "duplicates-group-row-disabled" : "cursor-pointer"
        }`}
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label={disabled
          ? `Duplicate episodes for ${label}; review unavailable during sync`
          : `Review duplicate episodes for ${label}`}
        onClick={() => {
          if (!disabled) onReviewSeason(season);
        }}
        onKeyDown={(event) => {
          if (disabled || event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onReviewSeason(season);
          }
        }}
      >
        <td>
          <div className="inline-flex min-w-0 items-center gap-3">
            <PosterThumb
              thumb={season.showThumb}
              width={60}
              height={90}
              className="h-14 w-10"
              hoverScope="row"
            />
            <div className="min-w-0">
              <div className="max-w-xs truncate font-medium">{season.showTitle}</div>
              <div className="max-w-xs truncate text-xs text-base-content/45">
                Season {season.seasonIndex}
              </div>
            </div>
          </div>
        </td>
        <td className="text-sm">
          <div className="duplicates-season-summary-cell">
            <HoverPopover
              openOnClick
              anchorClassName="duplicates-season-summary-anchor"
              content={
                <div className="duplicates-season-popover">
                  <div className="font-semibold">
                    Differences across this {summary.episodeCount}-episode pass of{" "}
                    {season.duplicateGroupCount} duplicate{" "}
                    {season.duplicateGroupCount === 1 ? "episode" : "episodes"}
                  </div>
                  <div className="duplicates-season-popover-list">
                    {allDifferences.map((difference) => (
                      <div key={difference.code}>
                        <span>{difference.label}</span>
                        <strong>{difference.episodeCount}</strong>
                      </div>
                    ))}
                    {summary.sameProfileEpisodeCount > 0 && (
                      <div>
                        <span>Matching technical profile</span>
                        <strong>{summary.sameProfileEpisodeCount}</strong>
                      </div>
                    )}
                    {summary.needsReviewEpisodeCount > 0 && (
                      <div className="is-review">
                        <span>Needs review</span>
                        <strong>{summary.needsReviewEpisodeCount}</strong>
                      </div>
                    )}
                  </div>
                  <p>Category counts overlap. Expand the season for episode-level details.</p>
                </div>
              }
            >
              <button
                type="button"
                className="duplicates-season-summary"
                aria-label={`Technical summary for the first ${summary.episodeCount} of ${season.duplicateGroupCount} duplicate episodes in ${label}: ${
                  seasonSummaryAccessibleText(summary)
                }`}
              >
                <Layers3 className="size-4 shrink-0 text-primary/60" aria-hidden="true" />
                <span className="duplicates-season-summary-copy">
                  <span className="duplicates-season-count">
                    {season.duplicateGroupCount} duplicate{" "}
                    {season.duplicateGroupCount === 1 ? "episode" : "episodes"}
                  </span>
                  <span className="duplicates-season-chips" aria-hidden="true">
                    {visibleDifferences.chips.map((difference) => (
                      <span key={difference.code} className="duplicates-season-difference-chip">
                        {difference.episodeCount} {difference.label}
                      </span>
                    ))}
                    {visibleDifferences.remaining > 0 && (
                      <span className="duplicates-season-difference-chip">
                        +{visibleDifferences.remaining}
                      </span>
                    )}
                    {summary.differences.length === 0 && summary.sameProfileEpisodeCount > 0 && (
                      <span className="duplicates-season-difference-chip is-match">
                        {summary.sameProfileEpisodeCount} matching
                      </span>
                    )}
                  </span>
                  <span className="duplicates-season-mobile-outcome" aria-hidden="true">
                    {summary.differentEpisodeCount > 0 && (
                      <span>{summary.differentEpisodeCount} differ</span>
                    )}
                    {summary.needsReviewEpisodeCount > 0 && (
                      <span>{summary.needsReviewEpisodeCount} review</span>
                    )}
                  </span>
                </span>
                {summary.needsReviewEpisodeCount > 0 && (
                  <span className="duplicates-season-review" aria-hidden="true">
                    <CircleHelp className="size-3" />
                    {summary.needsReviewEpisodeCount}
                  </span>
                )}
              </button>
            </HoverPopover>
            <button
              type="button"
              className="duplicates-season-expand"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} duplicate episodes for ${label}`}
              title={`${expanded ? "Hide" : "Show"} duplicate episodes`}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((current) => !current);
              }}
            >
              <ChevronRight
                className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`}
                aria-hidden="true"
              />
            </button>
          </div>
        </td>
        <td className="text-sm font-mono duplicates-storage">
          <div className="duplicates-storage-values">
            <span>
              {season.combinedFileSize !== null
                ? formatKilobytes(season.combinedFileSize)
                : "Unknown"}
            </span>
            <small
              title={partialPass
                ? `Potential savings if the largest version of each of the first ${season.episodes.length} episodes is kept`
                : "Potential savings if the largest version of each episode is kept"}
            >
              {reclaimable !== null
                ? `${formatKilobytes(reclaimable)} potential savings${
                  partialPass ? ` · first ${season.episodes.length}` : ""
                }`
                : "Potential savings unknown"}
            </small>
          </div>
          {reclaimable !== null && (
            <div
              className="duplicates-storage-track"
              title={`${
                Math.round(reclaimablePercent)
              }% potentially reclaimable if the largest version of each ${
                partialPass ? `of the first ${season.episodes.length} episodes` : "episode"
              } is kept`}
            >
              <div
                className="duplicates-storage-fill"
                style={{ width: `${reclaimablePercent}%` }}
              />
            </div>
          )}
        </td>
      </tr>
      {expanded && season.episodes.map((episode) => (
        <DuplicateGroupRow
          key={episode.episodeRatingKey}
          item={episode}
          nested
          disabled={disabled}
          onReview={() => onReviewEpisode(episode)}
        />
      ))}
    </>
  );
}
