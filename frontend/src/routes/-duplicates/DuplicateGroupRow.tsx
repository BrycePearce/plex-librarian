import { Link } from "@tanstack/react-router";
import { compareDuplicateVersions } from "@shared/mediaComparison";
import type { DuplicateGroup } from "../../lib/api";
import { formatKilobytes } from "../../lib/format";
import { PosterThumb } from "../../components/PosterThumb";
import { HoverPopover } from "../../components/HoverPopover";
import {
  comparisonIcon,
  comparisonToneClass,
  reclaimableKilobytes,
  versionQualityLabels,
} from "./duplicatePresentation";
import "../../components/dataSurfaces.css";

export function DuplicateGroupRow({
  item,
  onReview,
}: {
  item: DuplicateGroup;
  onReview: () => void;
}) {
  const reclaimable = reclaimableKilobytes(item.versions);
  const reclaimablePercent = reclaimable != null && item.combinedFileSize
    ? Math.min(100, Math.max(0, (reclaimable / item.combinedFileSize) * 100))
    : 0;
  const quality = versionQualityLabels(item.versions);
  const comparison = compareDuplicateVersions(item.versions);
  const ComparisonIcon = comparisonIcon(comparison.kind);

  const title = item.mediaType === "movie"
    ? (
      <div className="min-w-0">
        <div className="font-medium truncate max-w-xs">{item.title}</div>
        {item.year && (
          <div className="text-xs text-base-content/40">{item.year}</div>
        )}
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
      className="row-hover group polished-row cursor-pointer"
      onClick={onReview}
    >
      <td>
        <Link
          to={item.mediaType === "movie"
            ? "/libraries/$key/movies/$ratingKey"
            : "/libraries/$key/shows/$ratingKey"}
          params={{
            key: item.libraryKey,
            ratingKey: item.mediaType === "movie"
              ? item.ratingKey
              : item.showRatingKey,
          }}
          onClick={(event) => event.stopPropagation()}
          className="group/poster inline-flex items-center gap-3 hover:text-primary transition-colors max-w-full"
        >
          <PosterThumb
            thumb={item.mediaType === "movie" ? item.thumb : item.showThumb}
            width={60}
            height={90}
            className="w-10 h-14"
            hoverScope="poster"
          />
          {title}
        </Link>
      </td>
      <td className="text-sm">
        <div className="flex items-center gap-2.5">
          <span className="duplicates-version-stack" aria-hidden="true">
            {Array.from({ length: Math.min(3, item.versions.length) }).map(
              (_, index) => <span key={index} />,
            )}
          </span>
          <div>
            <div className="duplicates-version-count flex items-center gap-1.5">
              <span>{item.versions.length} versions</span>
              <HoverPopover
                content={
                  <>
                    <div className="font-semibold">{comparison.label}</div>
                    <div className="mt-0.5 opacity-70">
                      {comparison.reasons.join(" · ")}
                    </div>
                  </>
                }
              >
                <ComparisonIcon
                  className={`size-3.5 ${comparisonToneClass(comparison.kind)}`}
                  aria-label={comparison.label}
                />
              </HoverPopover>
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
        </div>
      </td>
      <td className="text-sm font-mono duplicates-storage">
        <div className="duplicates-storage-values">
          <span>
            {item.combinedFileSize != null
              ? formatKilobytes(item.combinedFileSize)
              : "—"}
          </span>
          {reclaimable != null && (
            <small title="Potential space if the largest version is kept">
              {formatKilobytes(reclaimable)} extra
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
      <td className="text-right">
        <button
          type="button"
          className="btn btn-sm opacity-70 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
          onClick={(event) => {
            event.stopPropagation();
            onReview();
          }}
        >
          Review
        </button>
      </td>
    </tr>
  );
}
