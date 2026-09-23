import { motion } from "motion/react";
import { Copy, Trash2 } from "lucide-react";
import type { StaleItem } from "../../lib/api.ts";
import { formatDate, formatKilobytes } from "../../lib/format.ts";
import { PosterThumb } from "../../components/PosterThumb.tsx";
import "../../components/dataSurfaces.css";

// `hidden` plays only on first mount, when `animateIn` is set.
// Opacity-only, deliberately no `y` offset: a translateY here once caused the table's
// `overflow-x-auto` wrapper to briefly grow its own vertical scrollbar mid-animation (it
// implicitly computes `overflow-y: auto` from having `overflow-x: auto` set at all), which
// snapped the table's width back once the animation settled. Not worth reintroducing for a
// barely-perceptible slide effect.
// The entrance transition (with its index-driven stagger delay) is passed as a plain prop
// rather than baked into the variants, since motion's dynamic (function) variants don't
// play well with a nested `transition` field under this version's types.
const rowVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

// A relative "how overdue" scale for the whole displayed set, not an absolute judgment —
// every row here already failed the "not viewed in" filter, so this is about which of the
// already-stale rows are the most stale, the same way the size bar is relative to the
// page's own max rather than some fixed byte threshold.
const DAY_SEC = 86_400;
function staleDotInfo(
  lastViewedAt: number,
): { className: string; title: string } {
  const daysSince = (Date.now() / 1000 - lastViewedAt) / DAY_SEC;
  if (daysSince > 730) {
    return { className: "bg-error", title: "Not viewed in over 2 years" };
  }
  if (daysSince > 365) {
    return { className: "bg-warning", title: "Not viewed in over 1 year" };
  }
  return { className: "bg-success", title: "Viewed within the last year" };
}

export function StaleItemRow({
  item,
  index,
  animateIn,
  maxFileSize,
  onDelete,
  historyUnknown,
}: {
  item: StaleItem;
  index: number;
  animateIn: boolean;
  maxFileSize: number;
  onDelete: () => void;
  historyUnknown: boolean;
}) {
  const versionCount = item.versions?.length ?? 0;
  const hasDuplicates = versionCount >= 2 || item.hasDuplicateEpisodes === true;
  const isSeason = item.type === "season" && item.showRatingKey !== undefined &&
    item.seasonIndex !== undefined;

  const titleEl = (
    <div className="min-w-0">
      <div className="font-medium max-w-xs flex items-center gap-1.5">
        <span className="truncate min-w-0">{item.title}</span>
        {hasDuplicates && (
          <span
            className="badge badge-outline badge-sm gap-1 shrink-0"
            title={versionCount >= 2
              ? `${versionCount} versions synced from Plex`
              : "One or more episodes have multiple synced versions"}
          >
            <Copy className="w-3 h-3" />
            {versionCount >= 2 ? versionCount : "Duplicates"}
          </span>
        )}
      </div>
      {isSeason
        ? (
          <div className="text-xs text-base-content/40">
            Season {item.seasonIndex}
            {item.leafCount != null ? ` · ${item.leafCount} episodes` : ""}
          </div>
        )
        : item.year && <div className="text-xs text-base-content/40">{item.year}</div>}
    </div>
  );

  const sizePct = item.fileSize != null ? Math.max(4, (item.fileSize / maxFileSize) * 100) : 0;

  const dotInfo = item.lastViewedAt ? staleDotInfo(item.lastViewedAt) : null;

  return (
    <motion.tr
      variants={rowVariants}
      initial={animateIn ? "hidden" : false}
      animate="visible"
      transition={animateIn
        ? {
          duration: 0.16,
          ease: "easeOut",
          delay: Math.min(index, 12) * 0.02,
        }
        : undefined}
      className="row-hover group polished-row cursor-pointer"
      onClick={onDelete}
    >
      <td>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          aria-label={`Review deletion of ${item.title}${
            isSeason ? `, season ${item.seasonIndex}` : ""
          }`}
          aria-haspopup="dialog"
          className="group/poster inline-flex items-center gap-3 text-left hover:text-primary transition-colors max-w-full rounded focus-visible:outline-2 focus-visible:outline-primary"
        >
          <PosterThumb
            thumb={item.thumb}
            width={60}
            height={90}
            className="w-10 h-14"
            hoverScope="row"
          />
          {titleEl}
        </button>
      </td>
      <td className="text-sm font-mono truncate relative overflow-hidden">
        {item.fileSize != null && (
          <motion.div
            className="absolute inset-y-1.5 left-0 bg-primary/15 rounded-sm"
            initial={{ width: 0 }}
            animate={{ width: `${sizePct}%` }}
            transition={{
              duration: 0.5,
              ease: "easeOut",
              delay: animateIn ? Math.min(index, 12) * 0.02 : 0,
            }}
          />
        )}
        <span className="relative">
          {item.fileSize != null ? formatKilobytes(item.fileSize) : "—"}
        </span>
      </td>
      <td className="text-sm text-base-content/70 truncate">
        {item.lastViewedAt && dotInfo
          ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotInfo.className}`}
                title={dotInfo.title}
              />
              {formatDate(item.lastViewedAt)}
            </span>
          )
          : historyUnknown
          ? (
            <span
              className="badge badge-warning badge-outline badge-sm"
              title="Watch-history sync hasn't completed for this library — this item may actually have been watched"
            >
              unknown
            </span>
          )
          : (
            <span className="badge badge-error badge-outline badge-sm">
              never
            </span>
          )}
      </td>
      <td className="text-sm text-base-content/70 truncate">
        {item.addedAt ? formatDate(item.addedAt) : "—"}
      </td>
      <td className="text-sm font-mono truncate">
        {item.viewCount ?? 0}
      </td>
      <td className="overflow-hidden">
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square text-error"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Review deletion of ${item.title}`}
          aria-haspopup="dialog"
          title="Review deletion"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </td>
    </motion.tr>
  );
}
