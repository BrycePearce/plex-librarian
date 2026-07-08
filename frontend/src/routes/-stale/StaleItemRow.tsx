import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { Trash2 } from "lucide-react";
import type { StaleItem } from "../../lib/api";
import { formatDate, formatKilobytes } from "../../lib/format";
import { PosterThumb } from "../../components/PosterThumb";

// `hidden`/`exit` play on delete (rows are only ever wrapped in AnimatePresence for a
// same-page deletion — see `animateRowRemoval` in the stale page) and, when `animateIn` is
// set, on first mount too.
// Opacity-only, deliberately no `y` offset: a translateY here once caused the table's
// `overflow-x-auto` wrapper to briefly grow its own vertical scrollbar mid-animation (it
// implicitly computes `overflow-y: auto` from having `overflow-x: auto` set at all), which
// snapped the table's width back once the animation settled. Not worth reintroducing for a
// barely-perceptible slide effect.
// The entrance transition (with its index-driven stagger delay) is passed as a plain prop
// rather than baked into the variants, since motion's dynamic (function) variants don't
// play well with a nested `transition` field under this version's types — the `exit`
// variant's own `transition` still overrides it for the delete animation.
const rowVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: {
    opacity: 0,
    transition: { duration: 0.15, ease: "easeIn" as const },
  },
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
  selected,
  onToggle,
  onDelete,
  historyUnknown,
}: {
  item: StaleItem;
  index: number;
  animateIn: boolean;
  maxFileSize: number;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
  historyUnknown: boolean;
}) {
  const titleEl = (
    <div className="min-w-0">
      <div className="font-medium truncate max-w-xs">{item.title}</div>
      {item.year && (
        <div className="text-xs text-base-content/40">{item.year}</div>
      )}
    </div>
  );

  const sizePct = item.fileSize != null
    ? Math.max(4, (item.fileSize / maxFileSize) * 100)
    : 0;

  const dotInfo = item.lastViewedAt ? staleDotInfo(item.lastViewedAt) : null;

  return (
    <motion.tr
      variants={rowVariants}
      initial={animateIn ? "hidden" : false}
      animate="visible"
      exit="exit"
      transition={animateIn
        ? {
          duration: 0.16,
          ease: "easeOut",
          delay: Math.min(index, 12) * 0.02,
        }
        : undefined}
      className={`row-hover group cursor-pointer ${
        selected ? "row-selected" : ""
      }`}
      onClick={onToggle}
    >
      <td
        className={`row-accent ${
          selected ? "shadow-[inset_3px_0_0_0_var(--color-primary)]" : ""
        }`}
      >
        <input
          type="checkbox"
          className="checkbox checkbox-sm"
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${item.title}`}
        />
      </td>
      <td className="row-accent">
        {item.type === "show"
          ? (
            <Link
              to="/libraries/$key/shows/$ratingKey"
              params={{ key: item.libraryKey, ratingKey: item.ratingKey }}
              onClick={(e) => e.stopPropagation()}
              className="group/poster inline-flex items-center gap-3 hover:text-primary transition-colors max-w-full"
            >
              <PosterThumb
                thumb={item.thumb}
                width={60}
                height={90}
                className="w-10 h-14"
                hoverScope="poster"
              />
              {titleEl}
            </Link>
          )
          : (
            <div className="flex items-center gap-3">
              <PosterThumb
                thumb={item.thumb}
                width={60}
                height={90}
                className="w-10 h-14"
                hoverScope="row"
              />
              {titleEl}
            </div>
          )}
      </td>
      <td className="row-accent text-sm font-mono truncate relative overflow-hidden">
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
      <td className="row-accent text-sm text-base-content/70 truncate">
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
      <td className="row-accent text-sm text-base-content/70 truncate">
        {item.addedAt ? formatDate(item.addedAt) : "—"}
      </td>
      <td className="row-accent text-sm font-mono truncate">
        {item.viewCount ?? 0}
      </td>
      <td className="row-accent overflow-hidden">
        <motion.button
          type="button"
          className={`btn btn-ghost btn-xs btn-square text-error ${
            selected ? "" : "pointer-events-none"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete ${item.title}`}
          title="Delete this item"
          tabIndex={selected ? 0 : -1}
          initial={false}
          animate={{ opacity: selected ? 1 : 0, x: selected ? 0 : -36 }}
          transition={{
            type: "spring",
            stiffness: 180,
            damping: 16,
            mass: 0.6,
          }}
        >
          <Trash2 className="w-4 h-4" />
        </motion.button>
      </td>
    </motion.tr>
  );
}
