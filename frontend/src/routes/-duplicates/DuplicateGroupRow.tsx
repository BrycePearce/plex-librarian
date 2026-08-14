import { compareDuplicateVersions } from "@shared/mediaComparison";
import type { DuplicateGroup } from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { PosterThumb } from "../../components/PosterThumb.tsx";
import { HoverPopover } from "../../components/HoverPopover.tsx";
import { reclaimableKilobytes, versionQualityLabels } from "./duplicatePresentation.ts";
import "../../components/dataSurfaces.css";

export function DuplicateGroupRow({
  item,
  onReview,
  disabled = false,
  nested = false,
}: {
  item: DuplicateGroup;
  onReview: () => void;
  disabled?: boolean;
  nested?: boolean;
}) {
  const reclaimable = reclaimableKilobytes(item.versions);
  const reclaimablePercent = reclaimable != null && item.combinedFileSize
    ? Math.min(100, Math.max(0, (reclaimable / item.combinedFileSize) * 100))
    : 0;
  const quality = versionQualityLabels(item.versions);
  const comparison = compareDuplicateVersions(item.versions);
  const itemLabel = item.mediaType === "movie"
    ? item.title
    : `${item.showTitle}, season ${item.seasonIndex}, episode ${item.episodeIndex}`;

  const title = item.mediaType === "movie"
    ? (
      <div className="min-w-0">
        <div className="font-medium truncate max-w-xs">{item.title}</div>
        {item.year && <div className="text-xs text-base-content/40">{item.year}</div>}
      </div>
    )
    : nested
    ? (
      <div className="min-w-0">
        <div className="font-medium truncate max-w-xs">
          E{String(item.episodeIndex).padStart(2, "0")} — {item.episodeTitle}
        </div>
        <div className="text-xs text-base-content/40">Episode duplicate</div>
      </div>
    )
    : (
      <div className="min-w-0">
        <div className="font-medium truncate max-w-xs">{item.showTitle}</div>
        <div className="text-xs text-base-content/40 truncate max-w-xs">
          S{item.seasonIndex}E{item.episodeIndex} — {item.episodeTitle}
        </div>
      </div>
    );

  return (
    <tr
      className={`duplicates-group-row duplicates-group-row-${comparison.kind} ${
        disabled ? "duplicates-group-row-disabled" : "cursor-pointer"
      } row-hover group polished-row focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary`}
      onClick={() => {
        if (!disabled) onReview();
      }}
      onKeyDown={(event) => {
        if (disabled || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onReview();
        }
      }}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={disabled
        ? `Duplicate versions for ${itemLabel}; review unavailable during sync`
        : `Review duplicate versions for ${itemLabel}`}
    >
      <td className={nested ? "duplicates-episode-title-cell" : undefined}>
        <div className="inline-flex items-center gap-3 max-w-full">
          {!nested && (
            <PosterThumb
              thumb={item.mediaType === "movie" ? item.thumb : item.showThumb}
              width={60}
              height={90}
              className="w-10 h-14"
              hoverScope="row"
            />
          )}
          {title}
        </div>
      </td>
      <td className="text-sm">
        <HoverPopover
          openOnClick
          content={
            <>
              <div className="font-semibold">{comparison.label}</div>
              <div className="mt-0.5 opacity-70">
                {comparison.reasons.join(" · ")}
              </div>
            </>
          }
        >
          <button
            type="button"
            className="duplicates-version-summary"
            aria-label={`${comparison.label}: ${comparison.reasons.join(", ")}`}
          >
            <span className="duplicates-version-stack" aria-hidden="true">
              {Array.from({ length: Math.min(3, item.versions.length) }).map(
                (_, index) => <span key={index} />,
              )}
            </span>
            <div>
              <div className="duplicates-version-count">
                {item.versions.length} versions
              </div>
              {quality.labels.length > 0 && (
                <div className="duplicates-quality">
                  {quality.labels.map((label) => (
                    <span key={label} className="duplicates-quality-chip">
                      {label}
                    </span>
                  ))}
                  {quality.remaining > 0 && (
                    <span className="duplicates-quality-chip">
                      +{quality.remaining}
                    </span>
                  )}
                </div>
              )}
            </div>
          </button>
        </HoverPopover>
      </td>
      <td className="text-sm font-mono duplicates-storage">
        <div className="duplicates-storage-values">
          <span>
            {item.combinedFileSize != null ? formatKilobytes(item.combinedFileSize) : "—"}
          </span>
          {reclaimable != null && (
            <small title="Potential space if the largest version is kept">
              {formatKilobytes(reclaimable)} potential savings
            </small>
          )}
        </div>
        {reclaimable != null && (
          <div
            className="duplicates-storage-track"
            title={`${
              Math.round(reclaimablePercent)
            }% potentially reclaimable if the largest version is kept`}
          >
            <div
              className="duplicates-storage-fill"
              style={{ width: `${reclaimablePercent}%` }}
            />
          </div>
        )}
      </td>
    </tr>
  );
}
