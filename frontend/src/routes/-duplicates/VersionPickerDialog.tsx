import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import type { DuplicateGroup, MediaVersion } from "../../lib/api";
import { formatKilobytes } from "../../lib/format";
import { versionLabel } from "../../lib/mediaVersion";
import "../../components/dataSurfaces.css";

// The version with the largest fileSize is treated as "the one to keep" and starts
// unchecked — every other version starts pre-checked for deletion. Ties keep the first.
function largestVersionId(versions: MediaVersion[]): number | null {
  if (versions.length === 0) return null;
  return versions.reduce((best, v) =>
    (v.fileSize ?? 0) > (best.fileSize ?? 0) ? v : best
  ).mediaId;
}

export function VersionPickerDialog({
  dialogRef,
  item,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  item: DuplicateGroup | null;
  pending: boolean;
  error: unknown;
  onConfirm: (mediaIds: number[], deleteWholeItem: boolean) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<Set<number>>(new Set());

  // Re-derive the default selection every time a different item is opened for review.
  useEffect(() => {
    if (!item) return;
    const keep = largestVersionId(item.versions);
    setChecked(
      new Set(
        item.versions.map((v) => v.mediaId).filter((id) => id !== keep),
      ),
    );
  }, [item]);

  if (!item) {
    return <dialog ref={dialogRef} className="modal" onClose={onCancel} />;
  }

  function toggle(mediaId: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(mediaId)) next.delete(mediaId);
      else next.add(mediaId);
      return next;
    });
  }

  const checkedCount = checked.size;
  const wouldDeleteAll = checkedCount >= item.versions.length;
  // Episodes have no whole-episode delete endpoint yet (episodes aren't rows in
  // `items`), so they keep the "uncheck one" block. Movies can fall through to the
  // same whole-item delete the stale page already uses.
  const allowWholeItemDelete = item.mediaType === "movie";
  const deleteWholeItem = wouldDeleteAll && allowWholeItemDelete;
  const wholeItemTitle = item.mediaType === "movie" ? item.title : null;
  const freedSize = item.versions
    .filter((v) => checked.has(v.mediaId))
    .reduce((sum, v) => sum + (v.fileSize ?? 0), 0);

  return (
    <dialog ref={dialogRef} className="modal" onClose={onCancel}>
      <div className="modal-box polished-modal">
        <h3 className="font-bold text-lg flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-error" />{" "}
          Resolve duplicate versions
        </h3>
        <p className="py-2 text-sm text-base-content/70">
          {item.mediaType === "movie"
            ? item.title
            : `${item.showTitle} — S${item.seasonIndex}E${item.episodeIndex} "${item.episodeTitle}"`}
          {" "}
          has {item.versions.length}{" "}
          versions synced from Plex. Choose which to permanently delete — this
          cannot be undone.
        </p>
        <ul className="mt-3 flex flex-col gap-2 py-1">
          {item.versions.map((v) => (
            <li
              key={v.mediaId}
              className="flex items-center gap-3 px-3 py-2 rounded-lg border border-base-300 bg-base-200/40"
            >
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={checked.has(v.mediaId)}
                onChange={() => toggle(v.mediaId)}
                aria-label={`Delete ${versionLabel(v)}`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">
                  {versionLabel(v)}
                </div>
              </div>
              <span className="text-base-content/50 font-mono text-xs shrink-0">
                {v.fileSize != null ? formatKilobytes(v.fileSize) : "—"}
              </span>
            </li>
          ))}
        </ul>
        {wouldDeleteAll && (
          <p className="text-warning text-sm">
            {allowWholeItemDelete
              ? (
                <>
                  This will delete "{wholeItemTitle}" entirely from Plex, not
                  just its duplicate versions. This cannot be undone.
                </>
              )
              : "At least one version must be kept — uncheck one to continue."}
          </p>
        )}
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
            onClick={() => onConfirm([...checked], deleteWholeItem)}
            disabled={pending || checkedCount === 0 ||
              (wouldDeleteAll && !allowWholeItemDelete)}
          >
            {pending
              ? <span className="loading loading-spinner loading-xs" />
              : <Trash2 className="w-4 h-4" />}
            {deleteWholeItem
              ? `Delete entire movie (${formatKilobytes(freedSize)})`
              : (
                <>
                  Delete {checkedCount} version{checkedCount === 1 ? "" : "s"}
                  {checkedCount > 0 && ` (${formatKilobytes(freedSize)})`}
                </>
              )}
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
