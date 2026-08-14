import { AlertTriangle, CircleHelp, CopyCheck } from "lucide-react";
import {
  DUPLICATE_DIFFERENCE_CODES,
  type DuplicateComparison,
  type DuplicateDifferenceCode,
  type DuplicateSeasonComparisonSummary,
} from "@shared/mediaComparison";
import type {
  DuplicateGroup,
  DuplicateListGroup,
  DuplicateSeasonGroup,
  MediaVersion,
} from "../../lib/api.ts";

// One icon and tone per comparison kind, shared by the duplicates list row, the
// comparison filter, and the version-picker modal so the same signal reads the same way
// everywhere a user encounters it — no separate legend to learn per surface.
export function comparisonIcon(kind: DuplicateComparison["kind"]) {
  switch (kind) {
    case "same-profile":
      return CopyCheck;
    case "different":
      return AlertTriangle;
    case "unknown":
      return CircleHelp;
  }
}

export function comparisonToneClass(kind: DuplicateComparison["kind"]): string {
  switch (kind) {
    case "same-profile":
      return "text-success";
    case "different":
      return "text-warning";
    case "unknown":
      return "text-base-content/40";
  }
}

export function reclaimableKilobytes(
  versions: readonly MediaVersion[],
): number | null {
  if (
    versions.length < 2 || versions.some((version) => version.fileSize == null)
  ) {
    return null;
  }

  const sizes = versions.map((version) => version.fileSize as number);
  return sizes.reduce((total, size) => total + size, 0) - Math.max(...sizes);
}

export function duplicatePageSummary(groups: readonly DuplicateListGroup[]) {
  const atomicGroups = groups.reduce<DuplicateGroup[]>((all, group) => {
    if (group.mediaType === "season") all.push(...group.episodes);
    else all.push(group);
    return all;
  }, []);
  // Season rows carry an exact aggregate for every eligible episode, while their nested
  // episode details are intentionally capped to one bounded review pass.
  const storageValues = groups.map((group) => group.combinedFileSize);
  const reclaimableValues = groups.map((group) =>
    group.mediaType === "season" ? group.reclaimableFileSize : reclaimableKilobytes(group.versions)
  );

  return {
    versionCount: atomicGroups.reduce(
      (total, group) => total + group.versions.length,
      0,
    ),
    storageKilobytes: storageValues.every((size) => size != null)
      ? storageValues.reduce((total, size) => total + (size ?? 0), 0)
      : null,
    reclaimableKilobytes: reclaimableValues.every((size) => size != null)
      ? reclaimableValues.reduce((total, size) => total + (size ?? 0), 0)
      : null,
  };
}

export function versionQualityLabels(
  versions: readonly MediaVersion[],
  limit = 3,
): { labels: string[]; remaining: number } {
  const labels = [
    ...new Set(
      versions
        .map((version) => version.videoResolution?.trim().toUpperCase())
        .filter((label): label is string => Boolean(label)),
    ),
  ];

  return {
    labels: labels.slice(0, limit),
    remaining: Math.max(0, labels.length - limit),
  };
}

export function seasonVersionCountLabel(season: DuplicateSeasonGroup): string {
  const counts = season.episodes.map((episode) => episode.versions.length);
  if (counts.length === 0) return "Versions unavailable";
  const maximum = Math.max(...counts);
  return `${maximum} versions`;
}

const SEASON_DIFFERENCE_SHORT_LABELS: Record<DuplicateDifferenceCode, string> = {
  resolution: "resolution",
  runtime: "runtime",
  "video-encoding": "video",
  "dynamic-range": "HDR",
  bitrate: "bitrate",
  "frame-rate": "frame rate",
  interlacing: "interlacing",
  container: "container",
  "audio-tracks": "audio",
  "subtitle-tracks": "subtitles",
};

export interface SeasonDifferenceChip {
  code: DuplicateDifferenceCode;
  episodeCount: number;
  label: string;
}

export function seasonDifferenceChips(
  summary: DuplicateSeasonComparisonSummary,
  limit = 2,
): { chips: SeasonDifferenceChip[]; remaining: number } {
  const priority = new Map(DUPLICATE_DIFFERENCE_CODES.map((code, index) => [code, index]));
  const sorted = [...summary.differences].sort((left, right) =>
    right.episodeCount - left.episodeCount ||
    (priority.get(left.code) ?? 0) - (priority.get(right.code) ?? 0)
  );
  const chips = sorted.slice(0, limit).map((difference) => ({
    ...difference,
    label: SEASON_DIFFERENCE_SHORT_LABELS[difference.code],
  }));
  return { chips, remaining: Math.max(0, sorted.length - chips.length) };
}

export function seasonSummaryAccessibleText(
  summary: DuplicateSeasonComparisonSummary,
): string {
  const parts = [
    `${summary.episodeCount} duplicate ${summary.episodeCount === 1 ? "episode" : "episodes"}`,
  ];
  for (const difference of seasonDifferenceChips(summary, Number.POSITIVE_INFINITY).chips) {
    parts.push(`${difference.episodeCount} ${difference.label}`);
  }
  if (summary.sameProfileEpisodeCount > 0) {
    parts.push(
      `${summary.sameProfileEpisodeCount} matching ${
        summary.sameProfileEpisodeCount === 1 ? "profile" : "profiles"
      }`,
    );
  }
  if (summary.needsReviewEpisodeCount > 0) {
    parts.push(`${summary.needsReviewEpisodeCount} need review`);
  }
  return `${parts.join(", ")}. Difference category counts may overlap.`;
}
