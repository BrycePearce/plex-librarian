import type { SeasonVersionProfile } from "../../lib/api.ts";

interface EpisodeCoverageLabel {
  compact: string;
  full: string;
  truncated: boolean;
}

export function seasonLaneMatchBasisLabel(
  basis: SeasonVersionProfile["matchBasis"],
): string {
  switch (basis) {
    case "release-root":
      return "Folder matched";
    case "filename-family":
      return "Filename matched";
    case "mixed":
      return "Mixed evidence";
    case "technical-only":
      return "Technical match";
  }
}

interface SeasonLanePathEntry {
  episodeRatingKey: string;
  episodeIndex: number | null;
  filePath: string | null;
}

export interface SeasonLanePathGroup {
  directory: string;
  files: Array<SeasonLanePathEntry & { filename: string }>;
}

export function groupSeasonLanePaths(
  entries: readonly SeasonLanePathEntry[],
): SeasonLanePathGroup[] {
  const groups = new Map<string, SeasonLanePathGroup>();
  for (const entry of entries) {
    if (!entry.filePath) continue;
    const originalPath = entry.filePath.trim();
    const separator = Math.max(originalPath.lastIndexOf("/"), originalPath.lastIndexOf("\\"));
    const directory = separator >= 0 ? originalPath.slice(0, separator) || "/" : "No folder";
    const filename = separator >= 0 ? originalPath.slice(separator + 1) : originalPath;
    const directoryKey = directory.replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase();
    const group = groups.get(directoryKey) ?? { directory, files: [] };
    group.files.push({ ...entry, filePath: originalPath, filename });
    groups.set(directoryKey, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    files: group.files.sort((left, right) =>
      (left.episodeIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.episodeIndex ?? Number.MAX_SAFE_INTEGER) ||
      left.episodeRatingKey.localeCompare(right.episodeRatingKey)
    ),
  })).sort((left, right) => left.directory.localeCompare(right.directory));
}

export function episodeCoverageLabel(
  episodeIndexes: readonly number[],
  maxSegments = 4,
): EpisodeCoverageLabel {
  const indexes = [...new Set(episodeIndexes.filter(Number.isSafeInteger))].sort(
    (left, right) => left - right,
  );
  if (indexes.length === 0) {
    return { compact: "No episodes", full: "No episodes", truncated: false };
  }

  const ranges: Array<{ start: number; end: number; count: number }> = [];
  for (const index of indexes) {
    const previous = ranges.at(-1);
    if (previous && index === previous.end + 1) {
      previous.end = index;
      previous.count += 1;
    } else {
      ranges.push({ start: index, end: index, count: 1 });
    }
  }

  const rangeLabel = (range: (typeof ranges)[number]) =>
    range.start === range.end ? `E${range.start}` : `E${range.start}–E${range.end}`;
  const full = ranges.map(rangeLabel).join(", ");
  if (ranges.length <= maxSegments) {
    return { compact: full, full, truncated: false };
  }

  const visibleCount = Math.max(1, maxSegments - 1);
  const visible = ranges.slice(0, visibleCount).map(rangeLabel).join(", ");
  const hiddenEpisodeCount = ranges
    .slice(visibleCount)
    .reduce((sum, range) => sum + range.count, 0);
  return {
    compact: `${visible}, +${hiddenEpisodeCount} more`,
    full,
    truncated: true,
  };
}
