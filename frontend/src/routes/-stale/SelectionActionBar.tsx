import { AnimatePresence, motion } from "motion/react";
import { Trash2 } from "lucide-react";
import { formatKilobytes } from "../../lib/format";

export function SelectionActionBar({
  count,
  totalSize,
  onClear,
  onDelete,
}: {
  count: number;
  totalSize: number;
  onClear: () => void;
  onDelete: () => void;
}) {
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 40 }}
          transition={{ type: "spring", stiffness: 300, damping: 28 }}
          className="selection-command-bar fixed bottom-6 left-0 right-0 mx-auto w-fit z-20 alert bg-base-200 shadow-xl border border-base-300 flex items-center justify-between gap-6"
        >
          <span>
            {count} item{count === 1 ? "" : "s"} selected · {formatKilobytes(totalSize)}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onClear}
            >
              Clear
            </button>
            <button
              type="button"
              className="btn btn-sm btn-error gap-2"
              onClick={onDelete}
            >
              <Trash2 className="w-4 h-4" /> Delete selected
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
