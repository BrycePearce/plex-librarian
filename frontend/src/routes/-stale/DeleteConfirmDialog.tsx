import type { RefObject } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import type { StaleItem } from "../../lib/api";
import { formatKilobytes } from "../../lib/format";

export function DeleteConfirmDialog({
  dialogRef,
  items,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  items: StaleItem[];
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const totalSize = items.reduce((sum, i) => sum + (i.fileSize ?? 0), 0);

  return (
    <dialog ref={dialogRef} className="modal" onClose={onCancel}>
      <div className="modal-box">
        <h3 className="font-bold text-lg flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-error" /> Delete{" "}
          {items.length} item
          {items.length === 1 ? "" : "s"}?
        </h3>
        <p className="py-2 text-sm text-base-content/70">
          This permanently deletes the underlying media file
          {items.length === 1 ? "" : "s"} from your Plex server (
          <span className="font-semibold text-base-content">
            {formatKilobytes(totalSize)}
          </span>{" "}
          total). This cannot be undone.
        </p>
        <ul className="mt-3 max-h-56 overflow-y-auto text-sm py-1 divide-y divide-base-300/50 rounded-lg border border-base-300 bg-base-200/40">
          {items.map((item) => (
            <li
              key={item.ratingKey}
              className="flex items-center justify-between gap-3 px-3 py-1.5"
            >
              <span className="truncate min-w-0 flex-1">{item.title}</span>
              <span className="text-base-content/50 font-mono text-xs shrink-0">
                {item.fileSize != null ? formatKilobytes(item.fileSize) : "—"}
              </span>
            </li>
          ))}
        </ul>
        {error != null && (
          <p className="text-error text-sm">
            {error instanceof Error ? error.message : "Delete failed"}
          </p>
        )}
        <div className="modal-action mt-3">
          <button
            type="button"
            className="btn btn-sm"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-error gap-2"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending
              ? <span className="loading loading-spinner loading-xs" />
              : <Trash2 className="w-4 h-4" />}
            Delete permanently
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit" disabled={pending}>
          close
        </button>
      </form>
    </dialog>
  );
}
