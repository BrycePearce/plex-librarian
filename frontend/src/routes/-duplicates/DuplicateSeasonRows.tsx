import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type DuplicateSeasonGroup, type DuplicateSeasonSummaryGroup } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import type { DuplicateComparisonFilter } from "@shared/mediaComparison";
import { analyzeSeasonVersionProfiles } from "../../../../shared/seasonVersionProfiles.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { PosterThumb } from "../../components/PosterThumb.tsx";
import { HoverPopover } from "../../components/HoverPopover.tsx";
import {
  seasonAffectedEpisodeLabel,
  seasonIsPartial,
  seasonSummaryAccessibleText,
  seasonVersionCountLabel,
  versionQualityLabels,
} from "./duplicatePresentation.ts";

export function DuplicateSeasonRows({
  season,
  disabled,
  onReviewSeason,
  comparison = "all",
  search = "",
}: {
  season: DuplicateSeasonGroup | DuplicateSeasonSummaryGroup;
  disabled: boolean;
  onReviewSeason: (season: DuplicateSeasonGroup) => void;
  comparison?: DuplicateComparisonFilter;
  search?: string;
}) {
  const [loadDetails, setLoadDetails] = useState(false);
  const [reviewRequested, setReviewRequested] = useState(false);
  const preview = useQuery({
    queryKey: queryKeys.duplicates.seasonPreview(season.seasonRatingKey, comparison, search),
    queryFn: () => api.duplicates.seasonPreview(season.seasonRatingKey, comparison, search),
    enabled: loadDetails && !disabled && !("episodes" in season),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const details = "episodes" in season ? season : preview.data;
  useEffect(() => {
    if (disabled) {
      setReviewRequested(false);
      return;
    }
    if (reviewRequested && details) {
      setReviewRequested(false);
      onReviewSeason(details);
    }
  }, [disabled, reviewRequested, details, onReviewSeason]);
  function requestReview() {
    if (disabled) return;
    if (details) {
      onReviewSeason(details);
      return;
    }
    setLoadDetails(true);
    setReviewRequested(true);
    if (preview.isError) void preview.refetch();
  }
  const partialPass = details ? details.episodes.length < season.duplicateGroupCount : false;
  const reclaimablePercent = season.reclaimableFileSize !== null && season.combinedFileSize
    ? Math.min(100, Math.max(0, (season.reclaimableFileSize / season.combinedFileSize) * 100))
    : 0;
  const label = `${season.showTitle}, season ${season.seasonIndex}`;
  const summary = details?.comparisonSummary;
  const versionCountLabel = seasonVersionCountLabel(season);
  const affectedEpisodeLabel = seasonAffectedEpisodeLabel(season);
  const partialSeason = seasonIsPartial(season);
  const maximumVersionCount = "maximumVersionCount" in season
    ? season.maximumVersionCount
    : Math.max(
      0,
      ...season.episodes.map((episode) => episode.versions.length),
    );
  const quality = versionQualityLabels(
    details?.episodes.flatMap((episode) => episode.versions) ?? [],
  );
  const versionProfiles = useMemo(
    () =>
      details && maximumVersionCount <= 11
        ? analyzeSeasonVersionProfiles(details.episodes).profiles
        : [],
    [details, maximumVersionCount],
  );
  const differenceLabels = (summary?.differences ?? []).map((difference) =>
    difference.code.replaceAll("-", " ")
  );

  return (
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
        requestReview();
      }}
      onKeyDown={(event) => {
        if (disabled || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          requestReview();
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
            {partialSeason && (
              <span className="duplicates-partial-season-badge">Partial season</span>
            )}
          </div>
        </div>
      </td>
      <td className="text-sm">
        <HoverPopover
          openOnClick
          onOpen={() => {
            if (!disabled) setLoadDetails(true);
          }}
          content={
            <div className="duplicates-season-popover">
              <div className="font-semibold">{affectedEpisodeLabel}</div>
              <p className="mt-0.5 text-base-content/60">
                Up to {versionCountLabel} per affected episode
                {partialPass ? ` · details sampled from the first ${details!.episodes.length}` : ""}
              </p>
              {versionProfiles.length > 0
                ? (
                  <div className="duplicates-season-profile-list">
                    {versionProfiles.map((profile, index) => (
                      <div key={profile.id}>
                        <span className="duplicates-season-profile-index">{index + 1}</span>
                        <span>
                          <strong>{profile.label}</strong>
                          <small>
                            {profile.coverageCount} of {details!.episodes.length} sampled episodes
                            {profile.technicalVariantCount > 1
                              ? ` · ${profile.technicalVariantCount} technical variants`
                              : ""}
                          </small>
                        </span>
                      </div>
                    ))}
                  </div>
                )
                : quality.labels.length > 0 && (
                  <div className="duplicates-quality mt-2">
                    {quality.labels.map((qualityLabel) => (
                      <span key={qualityLabel} className="duplicates-quality-chip">
                        {qualityLabel}
                      </span>
                    ))}
                    {quality.remaining > 0 && (
                      <span className="duplicates-quality-chip">+{quality.remaining}</span>
                    )}
                  </div>
                )}
              {summary && (
                <div className="duplicates-season-popover-outcome">
                  <span>{summary.differentEpisodeCount} sampled episodes differ</span>
                  {summary.sameProfileEpisodeCount > 0 && (
                    <span>{summary.sameProfileEpisodeCount} match technically</span>
                  )}
                  {summary.needsReviewEpisodeCount > 0 && (
                    <span>{summary.needsReviewEpisodeCount} need review</span>
                  )}
                </div>
              )}
              {!details && (
                <p>
                  {disabled
                    ? "Version details are paused during sync."
                    : preview.isError
                    ? "Could not load version details. Open the season to retry."
                    : "Loading version details…"}
                </p>
              )}
              {differenceLabels.length > 0 && (
                <p>Differences include {differenceLabels.join(", ")}.</p>
              )}
              <p>Open the season to review the exact episode files in each version.</p>
            </div>
          }
        >
          <button
            type="button"
            className="duplicates-version-summary"
            aria-label={`${affectedEpisodeLabel} in ${label}; ${versionCountLabel} per affected episode. ${
              summary ? seasonSummaryAccessibleText(summary) : "Open to load version details."
            }`}
          >
            <span className="duplicates-version-stack" aria-hidden="true">
              {Array.from({ length: Math.min(3, maximumVersionCount) }).map((_, index) => (
                <span key={index} />
              ))}
            </span>
            <div>
              <div className="duplicates-version-count">{affectedEpisodeLabel}</div>
              <div className="duplicates-version-detail">{versionCountLabel}</div>
              {reviewRequested && preview.isFetching && (
                <small role="status">Loading version details…</small>
              )}
              {reviewRequested && preview.isError && (
                <small role="alert">Could not load details. Click to retry.</small>
              )}
              {quality.labels.length > 0 && (
                <div className="duplicates-quality" aria-hidden="true">
                  {quality.labels.map((qualityLabel) => (
                    <span key={qualityLabel} className="duplicates-quality-chip">
                      {qualityLabel}
                    </span>
                  ))}
                  {quality.remaining > 0 && (
                    <span className="duplicates-quality-chip">+{quality.remaining}</span>
                  )}
                </div>
              )}
            </div>
          </button>
        </HoverPopover>
      </td>
      <td className="text-sm font-mono duplicates-storage">
        <div className="duplicates-storage-values">
          <span>
            {season.combinedFileSize !== null
              ? formatKilobytes(season.combinedFileSize)
              : "Unknown"}
          </span>
          <small title="Potential savings across all duplicate episodes if the largest version of each is kept">
            {season.reclaimableFileSize !== null
              ? `${formatKilobytes(season.reclaimableFileSize)} potential savings`
              : "Potential savings unknown"}
          </small>
        </div>
        {season.reclaimableFileSize !== null && (
          <div
            className="duplicates-storage-track"
            title={`${
              Math.round(reclaimablePercent)
            }% potentially reclaimable across all duplicate episodes if the largest version of each is kept`}
          >
            <div
              className="duplicates-storage-fill"
              style={{ width: `${reclaimablePercent}%` }}
            />
          </div>
        )}
      </td>
    </tr>
  );
}
