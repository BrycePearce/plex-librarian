import { AlertTriangle, CircleHelp, CopyCheck } from "lucide-react";
import type { DuplicateComparison } from "@shared/mediaComparison";
import type { DuplicateGroup, MediaVersion } from "../../lib/api.ts";

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

export function duplicatePageSummary(groups: readonly DuplicateGroup[]) {
  const storageValues = groups.map((group) => group.combinedFileSize);
  const reclaimableValues = groups.map((group) => reclaimableKilobytes(group.versions));

  return {
    versionCount: groups.reduce(
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
