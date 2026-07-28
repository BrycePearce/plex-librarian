import { useQuery } from "@tanstack/react-query";
import { InfoTip } from "../mediaDeletion/InfoTip.tsx";
import { api } from "../../lib/api.ts";
import type { SmartDuplicateCandidate } from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { versionLabel } from "../../lib/mediaVersion.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { VersionTechnicalInfo } from "../mediaDeletion/VersionTechnicalInfo.tsx";
import { candidateKey } from "./model.ts";

export function CandidateFileDetails({
  candidate,
  keepMediaId,
  onKeepChange,
}: {
  candidate: SmartDuplicateCandidate;
  keepMediaId: number;
  onKeepChange: (mediaId: number) => void;
}) {
  const preview = useQuery({
    queryKey: queryKeys.versionDeletionPreview.forVersions(
      candidate.mediaType,
      candidate.ratingKey,
      candidate.deleteMediaIds,
    ),
    queryFn: () =>
      api.duplicates.versionDeletionPreview(
        candidate.mediaType,
        candidate.ratingKey,
        candidate.deleteMediaIds,
      ),
    staleTime: 15_000,
    retry: false,
  });
  const previewById = new Map(
    preview.data?.availableVersions.map((version) => [version.mediaId, version]) ?? [],
  );

  return (
    <div className="smart-cleanup-file-details">
      <div className="smart-cleanup-file-details-header">
        Choose the version to keep
        <InfoTip text="The highest-resolution version is selected by default, followed by bitrate and file size. Change the selection here if you prefer another version. All other versions in this group will be removed." />
        {preview.isFetching && <span className="loading loading-spinner loading-xs ml-auto" />}
      </div>
      <div className="smart-cleanup-version-list">
        {candidate.versions.map((version) => {
          const kept = version.mediaId === keepMediaId;
          const pathPreview = previewById.get(version.mediaId);
          return (
            <label
              key={version.mediaId}
              className={`smart-cleanup-version-row ${kept ? "is-kept" : "is-removed"}`}
            >
              <input
                type="radio"
                name={`keep:${candidateKey(candidate)}`}
                className="radio radio-xs radio-success"
                checked={kept}
                onChange={() => onKeepChange(version.mediaId)}
              />
              <span
                className={`smart-cleanup-version-action ${kept ? "is-keep" : "is-remove"}`}
              >
                {kept ? "Keep" : "Remove"}
              </span>
              <span className="min-w-0 flex-1 truncate" title={versionLabel(version)}>
                {versionLabel(version)}
              </span>
              <VersionTechnicalInfo version={version} />
              {version.fileSize != null && (
                <span className="smart-cleanup-version-size">
                  {formatKilobytes(version.fileSize)}
                </span>
              )}
              <span className="smart-cleanup-version-path">
                {preview.isLoading
                  ? "Loading Plex path…"
                  : preview.isError
                  ? "Plex path unavailable"
                  : pathPreview?.plexPaths.length
                  ? pathPreview.plexPaths.join(" · ")
                  : pathPreview?.reason ?? "Plex did not return a file path"}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
