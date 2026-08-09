import type {
  MediaVersion,
  MediaVersionPathPreview,
  VersionDeletionPreviewResponse,
} from "../../lib/api.ts";

export function versionPathPreviewsByMediaId(
  availableVersions: readonly MediaVersionPathPreview[],
  selectedVersions: readonly MediaVersionPathPreview[] = [],
): Map<number, MediaVersionPathPreview> {
  // Selected previews carry the precise unavailable reason when a persisted version is
  // absent from Plex's live-version list, so they intentionally win on duplicate IDs.
  return new Map(
    [...availableVersions, ...selectedVersions].map((version) => [version.mediaId, version]),
  );
}

export function largestVersionId(versions: readonly MediaVersion[]): number | null {
  if (versions.length === 0) return null;
  return versions.reduce((best, version) =>
    (version.fileSize ?? 0) > (best.fileSize ?? 0) ? version : best
  ).mediaId;
}

export function defaultVersionSelection(versions: readonly MediaVersion[]): Set<number> {
  const keep = largestVersionId(versions);
  return new Set(versions.map((version) => version.mediaId).filter((id) => id !== keep));
}

export function versionSelectionSemantics(
  mediaType: "movie" | "episode",
  versions: readonly MediaVersion[],
  selectedMediaIds: ReadonlySet<number>,
) {
  const selectedVersions = versions.filter((version) => selectedMediaIds.has(version.mediaId));
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

export function versionDestinationState(preview: VersionDeletionPreviewResponse | undefined) {
  const arrDeleteAvailable = preview?.arrStatus === "resolved";
  const arrReassignAvailable = preview?.arrReassignStatus === "resolved" ||
    preview?.radarrPathAdoption.mode === "remove_from_radarr";
  const arrAvailable = arrDeleteAvailable || arrReassignAvailable;
  const arrVisible = preview?.arrConfigured === true && arrAvailable;
  const cleanupAvailable = preview?.cleanupStatus === "resolved";
  return {
    arrVisible,
    arrAvailable,
    arrDeleteAvailable,
    arrReassignAvailable,
    arrSelectedByDefault: arrVisible,
    cleanupAvailable,
    // A configured client is not itself a deletion destination. Only offer the
    // qBittorrent option after the preview has tied a live job to the selected paths.
    cleanupVisible: arrAvailable && preview?.cleanupStatus === "resolved" &&
      (preview.downloadJobs.length ?? 0) > 0,
  };
}

export function versionDestinationOptionVisibility(
  preview: VersionDeletionPreviewResponse | undefined,
) {
  const destinations = versionDestinationState(preview);
  return {
    // Reassignment is automatic and cannot be disabled, but it still needs to be visible
    // so the controls agree with the service marks on the selected version.
    arr: destinations.arrVisible,
    // Keep verified cleanup visible during reassignment too; the dialog explains why that
    // destination is temporarily locked instead of making a known association disappear.
    cleanup: destinations.cleanupVisible,
  };
}

export function versionPlexFallbackWarning(
  preview: VersionDeletionPreviewResponse | undefined,
): boolean {
  if (
    preview?.arrConfigured !== true ||
    preview.arrStatus === "resolved" ||
    preview.arrReassignStatus === "resolved"
  ) {
    return false;
  }
  return (
    preview.arrStatus === "error" || preview.arrSelectionMatched || preview.mediaType === "episode"
  );
}

export function versionRadarrPathOverride(
  preview: VersionDeletionPreviewResponse | undefined,
): VersionDeletionPreviewResponse["radarrPathAdoption"] | null {
  const candidate = preview?.radarrPathOverride;
  return candidate?.mode === "adopt_path_with_consent" &&
      candidate.requiresConsent &&
      Boolean(candidate.planFingerprint) &&
      Boolean(candidate.proposedMoviePath) &&
      Boolean(candidate.retainedPath)
    ? candidate
    : null;
}

export function versionArrDestinationCopy(
  preview: VersionDeletionPreviewResponse | undefined,
  arrLabel: string,
  arrReassignAvailable: boolean,
): { label: string; info: string } {
  if (preview?.radarrPathAdoption.mode === "remove_from_radarr") {
    return {
      label: arrLabel,
      info:
        `Required to complete this deletion safely: ${arrLabel} will stop managing the movie without being asked to delete any files.`,
    };
  }
  return arrReassignAvailable
    ? {
      label: arrLabel,
      info:
        `Required to keep the ${arrLabel} record: ${arrLabel} will adopt an unselected Plex version before removing its currently managed file.`,
    }
    : {
      label: arrLabel,
      info:
        `Removes only the ${arrLabel} record whose managed paths match the selected Plex versions.`,
    };
}

export function versionDeletionPresentation(
  preview: VersionDeletionPreviewResponse | undefined,
  deleteFromArr: boolean,
  cleanupDownloads: boolean,
) {
  const arrTargets = deleteFromArr && preview?.arrStatus === "resolved" ? preview.arrTargets : [];
  const downloadJobs = deleteFromArr && cleanupDownloads && preview?.cleanupStatus === "resolved"
    ? preview.downloadJobs
    : [];
  const orphanFiles = deleteFromArr && cleanupDownloads && preview?.cleanupStatus === "resolved"
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
    // Advanced mode should always retain Plex's view of the selected files. Arr and
    // qBittorrent paths explain additional actions; they do not replace the Plex paths.
    showPlexPaths: true,
  };
}

export function versionArrDeletionActive(
  deleteFromArr: boolean,
  arrStatus: "resolved" | "unavailable" | "error" | undefined,
): boolean {
  return deleteFromArr && arrStatus === "resolved";
}
