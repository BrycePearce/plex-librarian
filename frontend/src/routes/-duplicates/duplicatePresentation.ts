import type { DuplicateGroup, MediaVersion } from "../../lib/api.ts";

export function reclaimableKilobytes(
  versions: readonly MediaVersion[],
): number | null {
  if (
    versions.length < 2 ||
    versions.some((version) => version.fileSize == null)
  ) {
    return null;
  }

  const sizes = versions.map((version) => version.fileSize as number);
  return sizes.reduce((total, size) => total + size, 0) - Math.max(...sizes);
}

export function duplicatePageSummary(groups: readonly DuplicateGroup[]) {
  const storageValues = groups.map((group) => group.combinedFileSize);
  const reclaimableValues = groups.map((group) =>
    reclaimableKilobytes(group.versions)
  );

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
