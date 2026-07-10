import type { DuplicateGroup } from "../../lib/api";
import { formatKilobytes } from "../../lib/format";
import { PosterThumb } from "../../components/PosterThumb";

export function DuplicateGroupRow({
  item,
  onReview,
}: {
  item: DuplicateGroup;
  onReview: () => void;
}) {
  return (
    <tr className="row-hover">
      <td>
        <div className="flex items-center gap-3">
          <PosterThumb
            thumb={item.mediaType === "movie" ? item.thumb : item.showThumb}
            width={60}
            height={90}
            className="w-10 h-14"
          />
          <div className="min-w-0">
            {item.mediaType === "movie"
              ? (
                <>
                  <div className="font-medium truncate max-w-xs">
                    {item.title}
                  </div>
                  {item.year && (
                    <div className="text-xs text-base-content/40">
                      {item.year}
                    </div>
                  )}
                </>
              )
              : (
                <>
                  <div className="font-medium truncate max-w-xs">
                    {item.showTitle}
                  </div>
                  <div className="text-xs text-base-content/40 truncate max-w-xs">
                    S{item.seasonIndex}E{item.episodeIndex} —{" "}
                    {item.episodeTitle}
                  </div>
                </>
              )}
          </div>
        </div>
      </td>
      <td className="text-sm">
        <span className="badge badge-outline">
          {item.versions.length} versions
        </span>
      </td>
      <td className="text-sm font-mono">
        {item.combinedFileSize != null
          ? formatKilobytes(item.combinedFileSize)
          : "—"}
      </td>
      <td className="text-right">
        <button type="button" className="btn btn-sm" onClick={onReview}>
          Review
        </button>
      </td>
    </tr>
  );
}
