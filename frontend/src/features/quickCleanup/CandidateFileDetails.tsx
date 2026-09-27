import { InfoTip } from "../mediaDeletion/InfoTip.tsx";
import type { SmartDuplicateCandidate } from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { versionLabel } from "../../lib/mediaVersion.ts";
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
  return (
    <div className="smart-cleanup-file-details">
      <div className="smart-cleanup-file-details-header">
        Choose the version to keep
        <InfoTip text="The highest-resolution version is selected by default, followed by bitrate and file size. Change the selection here if you prefer another version. All other versions in this group will be removed." />
      </div>
      <p className="text-xs text-base-content/60">
        File paths are shown in the next deletion review.
      </p>
      <div className="smart-cleanup-version-list">
        {candidate.versions.map((version) => {
          const kept = version.mediaId === keepMediaId;
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
            </label>
          );
        })}
      </div>
    </div>
  );
}
