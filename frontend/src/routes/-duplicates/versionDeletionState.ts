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
    // A verified reassignment is selected by default, but remains an explicit destination
    // choice so the user can opt into Plex-only deletion.
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
  canDisable = true,
  selected = true,
  remainingVersionCount = 1,
): { label: string; info: string } {
  const plexOnlyInfo = `${arrLabel} will not be changed. Plex will delete the selected file ` +
    `directly, and ${arrLabel} may download it again if the title remains monitored.`;
  const remainingVersionLabel = remainingVersionCount === 1
    ? "remaining version"
    : "best remaining version";
  if (preview?.radarrPathAdoption.mode === "remove_from_radarr") {
    return {
      label: `Remove movie from ${arrLabel}`,
      info: selected
        ? `${arrLabel} cannot safely adopt any remaining Plex version. Plex Librarian will ` +
          `unmonitor the movie, create an import exclusion, and remove its ${arrLabel} record ` +
          `without asking ${arrLabel} to delete files. Plex then deletes the selected version.`
        : plexOnlyInfo,
    };
  }
  return arrReassignAvailable
    ? {
      label: `Switch ${arrLabel} to ${remainingVersionLabel}`,
      info: selected
        ? `${canDisable ? "" : "Required to keep the record: "}${arrLabel} currently manages ` +
          `the selected file. Before Plex deletes it, Plex Librarian will make ${arrLabel} adopt ` +
          `the ${remainingVersionLabel} and preserve the existing monitoring state.${
            remainingVersionCount > 1
              ? ` ${arrLabel} switches to only the highest-ranked eligible survivor; other ` +
                `remaining Plex versions stay unchanged.`
              : ""
          }`
        : plexOnlyInfo,
    }
    : {
      label: `Remove from ${arrLabel}`,
      info: selected
        ? `Removes only the ${arrLabel} record whose managed paths match the selected Plex versions.`
        : plexOnlyInfo,
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
