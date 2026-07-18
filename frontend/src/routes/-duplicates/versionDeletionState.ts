import type {
  MediaVersion,
  VersionDeletionPreviewResponse,
} from "../../lib/api.ts";

export function largestVersionId(
  versions: readonly MediaVersion[],
): number | null {
  if (versions.length === 0) return null;
  return versions.reduce((best, version) =>
    (version.fileSize ?? 0) > (best.fileSize ?? 0) ? version : best
  ).mediaId;
}

export function defaultVersionSelection(
  versions: readonly MediaVersion[],
): Set<number> {
  const keep = largestVersionId(versions);
  return new Set(
    versions.map((version) => version.mediaId).filter((id) => id !== keep),
  );
}

export function versionSelectionSemantics(
  mediaType: "movie" | "episode",
  versions: readonly MediaVersion[],
  selectedMediaIds: ReadonlySet<number>,
) {
  const selectedVersions = versions.filter((version) =>
    selectedMediaIds.has(version.mediaId)
  );
  const wouldDeleteAll = selectedVersions.length >= versions.length;
  return {
    selectedVersions,
    wouldDeleteAll,
    deleteWholeItem: wouldDeleteAll && mediaType === "movie",
    blocked: wouldDeleteAll && mediaType === "episode",
  };
}

export function versionDeletionExecutionTarget(
  mediaType: "movie" | "episode",
  deleteWholeItem: boolean,
): "whole-item" | "versions" {
  return mediaType === "movie" && deleteWholeItem ? "whole-item" : "versions";
}

export function versionDestinationState(
  preview: VersionDeletionPreviewResponse | undefined,
) {
  const arrVisible = preview?.arrConfigured === true;
  const arrAvailable = preview?.arrStatus === "resolved";
  const cleanupAvailable = preview?.cleanupStatus === "resolved";
  return {
    arrVisible,
    arrAvailable,
    arrSelectedByDefault: arrVisible,
    cleanupAvailable,
    cleanupVisible: arrVisible && preview?.cleanupConfigured === true &&
      (cleanupAvailable || preview?.cleanupStatus === "error"),
  };
}

export function versionDeletionPresentation(
  preview: VersionDeletionPreviewResponse | undefined,
  deleteFromArr: boolean,
  cleanupDownloads: boolean,
) {
  const arrTargets = deleteFromArr && preview?.arrStatus === "resolved"
    ? preview.arrTargets
    : [];
  const downloadJobs = deleteFromArr && cleanupDownloads &&
      preview?.cleanupStatus === "resolved"
    ? preview.downloadJobs
    : [];
  const orphanFiles = deleteFromArr && cleanupDownloads &&
      preview?.cleanupStatus === "resolved"
    ? preview.orphanFiles
    : [];
  return {
    services: [
      "plex" as const,
      ...(arrTargets.length > 0 ? [preview!.arrService] : []),
      ...(downloadJobs.length > 0 ? ["qbittorrent" as const] : []),
    ],
    arrTargets,
    downloadJobs,
    orphanFiles,
    showPlexPaths: arrTargets.length === 0,
  };
}
