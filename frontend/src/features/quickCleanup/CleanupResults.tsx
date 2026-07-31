import { useEffect, useRef } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Film,
  HardDrive,
  ShieldCheck,
  Sparkles,
  Tv,
} from "lucide-react";
import type { SmartDuplicateAnalysisResponse, SmartDuplicateCandidate } from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { versionLabel } from "../../lib/mediaVersion.ts";
import { HoverPopover } from "../../components/HoverPopover.tsx";
import { CandidateFileDetails } from "./CandidateFileDetails.tsx";
import { candidateKey, candidateReclaimableSize } from "./model.ts";

type RecommendedConfidence = "obvious" | "near-identical";

interface CleanupResultsProps {
  analysis: SmartDuplicateAnalysisResponse;
  selected: ReadonlySet<string>;
  keepSelections: ReadonlyMap<string, number>;
  expandedCandidate: string | null;
  reclaimableSize: number | null;
  onToggleCandidate: (candidate: SmartDuplicateCandidate) => void;
  onSetConfidenceSelection: (confidence: RecommendedConfidence, selected: boolean) => void;
  onExpandedCandidateChange: (key: string | null) => void;
  onKeepChange: (candidate: SmartDuplicateCandidate, mediaId: number) => void;
}

function ConfidenceSelectionToggle({
  confidence,
  label,
  count,
  selectedCount,
  onChange,
}: {
  confidence: RecommendedConfidence;
  label: string;
  count: number;
  selectedCount: number;
  onChange: (selected: boolean) => void;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const checked = count > 0 && selectedCount === count;
  const indeterminate = selectedCount > 0 && selectedCount < count;

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-base-content/75 transition-colors"
      title={`${selectedCount.toLocaleString()} of ${count.toLocaleString()} selected`}
    >
      <input
        ref={checkboxRef}
        type="checkbox"
        className="checkbox checkbox-sm mr-0.5"
        checked={checked}
        aria-checked={indeterminate ? "mixed" : checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      {confidence === "obvious"
        ? <CheckCircle2 className="size-4 shrink-0 text-success" />
        : <Sparkles className="size-4 shrink-0 text-warning" />}
      <span className="whitespace-nowrap font-medium">{label}</span>
      <span className="font-mono text-xs text-base-content/40">
        {count.toLocaleString()}
      </span>
    </label>
  );
}

export function CleanupResults({
  analysis,
  selected,
  keepSelections,
  expandedCandidate,
  reclaimableSize,
  onToggleCandidate,
  onSetConfidenceSelection,
  onExpandedCandidateChange,
  onKeepChange,
}: CleanupResultsProps) {
  const visibleCandidates = analysis.candidates.filter(
    (candidate) => candidate.confidence !== "review",
  );
  const identicalCount = visibleCandidates.filter(
    (candidate) => candidate.confidence === "obvious",
  ).length;
  const nearIdenticalCount = visibleCandidates.filter(
    (candidate) => candidate.confidence === "near-identical",
  ).length;
  const reviewCount = analysis.candidates.filter(
    (candidate) => candidate.confidence === "review",
  ).length;
  const excludedCount = analysis.protectedGroups + reviewCount;
  const selectedIdenticalCount = visibleCandidates.filter(
    (candidate) => candidate.confidence === "obvious" && selected.has(candidateKey(candidate)),
  ).length;
  const selectedNearIdenticalCount = visibleCandidates.filter(
    (candidate) =>
      candidate.confidence === "near-identical" && selected.has(candidateKey(candidate)),
  ).length;

  return (
    <>
      <div className="smart-cleanup-result-grid">
        <HoverPopover
          content="Versions whose Plex-reported runtime, resolution, video, HDR, audio, subtitles, and container match, with a bitrate difference of 5% or less. This does not prove the files are byte-identical."
          anchorClassName="smart-cleanup-stat-tip"
          anchorTabIndex={0}
        >
          <CheckCircle2 className="size-4 text-success" />
          <span>Likely identical</span>
          <strong>{identicalCount.toLocaleString()}</strong>
        </HoverPopover>
        <HoverPopover
          content="Versions with matching runtime and core audio/video characteristics, but a resolution difference, a bitrate difference of 15% or less, or some differing subtitle tracks with shared language coverage. The higher-quality copy is kept by default."
          anchorClassName="smart-cleanup-stat-tip"
          anchorTabIndex={0}
        >
          <Sparkles className="size-4 text-warning" />
          <span>Near-identical</span>
          <strong>{nearIdenticalCount.toLocaleString()}</strong>
        </HoverPopover>
        <HoverPopover
          content="Groups not recommended for automatic cleanup because of meaningful differences, a container change, a larger bitrate gap, incomplete metadata, or active playback. They remain available on the Duplicates page for manual review."
          anchorClassName="smart-cleanup-stat-tip"
          anchorTabIndex={0}
        >
          <ShieldCheck className="size-4 text-info" />
          <span>Not included</span>
          <strong>{excludedCount.toLocaleString()}</strong>
        </HoverPopover>
        <HoverPopover
          content="Estimated space reclaimed by removing the currently selected versions. The version marked Keep remains for each title."
          anchorClassName="smart-cleanup-stat-tip smart-cleanup-savings-stat"
          anchorTabIndex={0}
        >
          <HardDrive className="size-4 text-primary" />
          <span>Selected savings</span>
          <strong className="smart-cleanup-savings-value">
            {reclaimableSize != null ? formatKilobytes(reclaimableSize) : "Unknown"}
          </strong>
        </HoverPopover>
      </div>

      {visibleCandidates.length > 0 && (
        <div className="smart-cleanup-action-explainer">
          <ShieldCheck className="size-4 shrink-0 text-success" />
          <span>
            Plex Librarian keeps your best copy by default and safely transfers any Sonarr or Radarr
            association without changing its monitored status.
          </span>
        </div>
      )}

      {visibleCandidates.length === 0
        ? (
          <div className="smart-cleanup-empty">
            <ShieldCheck className="size-8 text-success" />
            <strong>No recommended cleanup candidates</strong>
            <span>
              This cleanup pass did not find any groups it can recommend automatically. The{" "}
              {analysis.analyzedGroups.toLocaleString()}{" "}
              groups checked in this pass stay available for individual review, along with any
              duplicates outside the bounded scan.
            </span>
          </div>
        )
        : (
          <div className="smart-cleanup-list" role="list">
            {(["movie", "episode"] as const).map((mediaType) => {
              const section = visibleCandidates.filter((candidate) =>
                candidate.mediaType === mediaType
              );
              if (section.length === 0) return null;
              return (
                <details key={mediaType} className="smart-cleanup-section" open>
                  <summary className="smart-cleanup-section-title">
                    {mediaType === "movie"
                      ? <Film className="size-3.5" />
                      : <Tv className="size-3.5" />}
                    {mediaType === "movie" ? "Movie libraries" : "TV libraries"}
                    <span>{section.length.toLocaleString()}</span>
                  </summary>
                  {section.map((candidate) => {
                    const key = candidateKey(candidate);
                    const checked = selected.has(key);
                    const expanded = expandedCandidate === key;
                    const keepMediaId = keepSelections.get(key) ?? candidate.keepMediaId;
                    const keepVersion = candidate.versions.find((version) =>
                      version.mediaId === keepMediaId
                    );
                    const candidateSavings = candidateReclaimableSize(candidate, keepMediaId);
                    const detailsId = `quick-cleanup-details-${mediaType}-${candidate.ratingKey}`;
                    return (
                      <div key={key}>
                        <div
                          className={`smart-cleanup-candidate ${checked ? "is-selected" : ""}`}
                        >
                          <label
                            className="smart-cleanup-candidate-toggle"
                            title={checked ? "Exclude from cleanup" : "Include in cleanup"}
                          >
                            <input
                              type="checkbox"
                              className="checkbox checkbox-sm checkbox-primary"
                              checked={checked}
                              aria-label={`${checked ? "Exclude" : "Include"} ${candidate.title} ${
                                checked ? "from" : "in"
                              } cleanup`}
                              onChange={() => onToggleCandidate(candidate)}
                            />
                          </label>
                          <button
                            type="button"
                            className="smart-cleanup-candidate-review"
                            aria-expanded={expanded}
                            aria-controls={detailsId}
                            onClick={() => onExpandedCandidateChange(expanded ? null : key)}
                          >
                            <span className="smart-cleanup-candidate-copy">
                              <strong className="block truncate">{candidate.title}</strong>
                              <small className="block truncate">
                                {candidate.context && `${candidate.context} · `}
                                Remove {candidate.deleteMediaIds.length}{" "}
                                {candidate.deleteMediaIds.length === 1 ? "version" : "versions"}
                                {keepVersion && ` · Keep ${versionLabel(keepVersion)}`}
                              </small>
                            </span>
                            <span
                              className={`badge badge-sm ${
                                candidate.confidence === "obvious"
                                  ? "badge-success"
                                  : candidate.confidence === "near-identical"
                                  ? "badge-warning"
                                  : "badge-info"
                              } badge-outline`}
                              title={candidate.reasons.join(". ")}
                            >
                              {candidate.confidence === "obvious"
                                ? "Likely identical"
                                : "Near-identical"}
                            </span>
                            <span className="w-24 text-right font-mono text-xs">
                              {candidateSavings != null
                                ? formatKilobytes(candidateSavings)
                                : "Unknown"}
                            </span>
                            <span className="smart-cleanup-files-button">
                              Review
                              <ChevronDown
                                className={`size-3 transition-transform ${
                                  expanded ? "rotate-180" : ""
                                }`}
                              />
                            </span>
                          </button>
                        </div>
                        {expanded && (
                          <div id={detailsId} role="region" aria-label={`${candidate.title} files`}>
                            <CandidateFileDetails
                              candidate={candidate}
                              keepMediaId={keepMediaId}
                              onKeepChange={(mediaId) =>
                                onKeepChange(candidate, mediaId)}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </details>
              );
            })}
          </div>
        )}

      {visibleCandidates.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-2 px-1">
          <ConfidenceSelectionToggle
            confidence="obvious"
            label="Likely identical"
            count={identicalCount}
            selectedCount={selectedIdenticalCount}
            onChange={(checked) => onSetConfidenceSelection("obvious", checked)}
          />
          <ConfidenceSelectionToggle
            confidence="near-identical"
            label="Near-identical"
            count={nearIdenticalCount}
            selectedCount={selectedNearIdenticalCount}
            onChange={(checked) => onSetConfidenceSelection("near-identical", checked)}
          />
        </div>
      )}
    </>
  );
}
