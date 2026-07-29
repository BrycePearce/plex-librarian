import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FolderOpen } from "lucide-react";
import type { StaleQuickCleanupCandidate } from "../../lib/api.ts";
import { api } from "../../lib/api.ts";
import { formatDate, formatKilobytes } from "../../lib/format.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { formatQuickCleanupInactivity } from "./quickCleanupPresentation.ts";

export function QuickCleanupCandidateRow({
  candidate,
  checked,
  expanded,
  onToggle,
  onExpandedChange,
}: {
  candidate: StaleQuickCleanupCandidate;
  checked: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpandedChange: () => void;
}) {
  const detailsId = `quick-stale-paths-${candidate.ratingKey}`;
  const preview = useQuery({
    queryKey: queryKeys.downloadCleanupPreview.forItems(
      candidate.libraryKey,
      [candidate.ratingKey],
    ),
    queryFn: () =>
      api.libraries.downloadCleanupPreview(candidate.libraryKey, [candidate.ratingKey]),
    enabled: expanded,
    staleTime: 15_000,
    retry: false,
  });
  const previewItem = preview.data?.items[0];

  return (
    <div>
      <div className={`smart-cleanup-candidate ${checked ? "is-selected" : ""}`}>
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
            onChange={onToggle}
          />
        </label>
        <button
          type="button"
          className="smart-cleanup-candidate-review"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={onExpandedChange}
        >
          <span className="smart-cleanup-candidate-copy">
            <strong className="block truncate">{candidate.title}</strong>
            <small className="block truncate">
              {candidate.year ? `${candidate.year} · ` : ""}
              {candidate.reason === "never-watched"
                ? `Never watched · added ${formatDate(candidate.addedAt!)}`
                : `Last watched ${formatDate(candidate.lastViewedAt!)}`}
            </small>
          </span>
          <span className="quick-stale-inactivity">
            {formatQuickCleanupInactivity(candidate.inactiveSince)}
          </span>
          <strong className="quick-stale-size">
            {candidate.fileSize != null ? formatKilobytes(candidate.fileSize) : "Unknown"}
          </strong>
          <span className="smart-cleanup-files-button">
            Paths
            <ChevronDown
              className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </span>
        </button>
      </div>

      {expanded && (
        <div
          id={detailsId}
          className="smart-cleanup-file-details quick-stale-file-details"
          role="region"
          aria-label={`${candidate.title} file paths`}
        >
          <div className="smart-cleanup-file-details-header">
            <FolderOpen className="size-3.5" />
            Plex paths removed with this title
            {preview.isFetching && <span className="loading loading-spinner loading-xs ml-auto" />}
          </div>
          <div className="smart-cleanup-version-list">
            {preview.isLoading
              ? <div className="quick-stale-path-row text-base-content/45">Loading Plex paths…</div>
              : preview.isError
              ? (
                <div className="quick-stale-path-row text-error">
                  Plex paths are unavailable right now.
                </div>
              )
              : previewItem?.plexPaths.length
              ? (
                <>
                  {previewItem.plexPaths.map((path) => (
                    <div className="quick-stale-path-row" key={path} title={path}>
                      <FolderOpen className="size-3.5 shrink-0 text-primary" />
                      <code>{path}</code>
                    </div>
                  ))}
                  {previewItem.plexPathsTruncated && (
                    <div className="quick-stale-path-note">
                      Showing the first {previewItem.plexPaths.length.toLocaleString()}{" "}
                      paths Plex reported; additional paths may be removed.
                    </div>
                  )}
                </>
              )
              : (
                <div className="quick-stale-path-row text-base-content/45">
                  {previewItem?.plexPathReason ?? "Plex did not return an underlying media path."}
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  );
}
