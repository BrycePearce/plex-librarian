import { useState } from "react";
import type { RefObject } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Copy, Trash2 } from "lucide-react";
import type { StaleItem } from "../../lib/api";
import { formatKilobytes } from "../../lib/format";
import { versionLabel } from "../../lib/mediaVersion";
import "../../components/dataSurfaces.css";

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
  onConfirm: (mode: "coordinated" | "plex-only") => void;
  onCancel: () => void;
}) {
  const [plexOnly, setPlexOnly] = useState(false);
  const cancel = () => {
    setPlexOnly(false);
    onCancel();
  };
  const totalSize = items.reduce((sum, i) => sum + (i.fileSize ?? 0), 0);
  // Deleting here removes every synced Media version of an item, not just a redundant
  // one — surfaced per-item below (a full version tree for movies, a lighter indicator
  // for shows) rather than a separate warning callout. See Duplicate detection in
  // CLAUDE.md. Movies carry per-version detail via `versions`; shows only carry the
  // existence flag `hasDuplicateEpisodes` (episode_media_versions isn't rolled up
  // per-show) — same signal StaleItemRow's badge already uses.
  const hasMultiVersionItems = items.some((i) =>
    (i.versions?.length ?? 0) >= 2 || i.hasDuplicateEpisodes === true
  );

  return (
    <dialog ref={dialogRef} className="modal" onClose={cancel}>
      <div className="modal-box polished-modal">
        <h3 className="font-bold text-lg flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-error" /> Delete {items.length}
          {" "}
          item
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
          {items.map((item) => {
            const versions = item.versions ?? [];
            const isMultiVersion = versions.length >= 2;
            return (
              <li key={item.ratingKey} className="px-3 py-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate min-w-0 flex-1 flex items-center gap-1.5">
                    <span className="truncate">{item.title}</span>
                    {!isMultiVersion && item.hasDuplicateEpisodes && (
                      <Copy
                        className="w-3 h-3 text-warning shrink-0"
                        aria-label="Has duplicate episodes"
                      />
                    )}
                  </span>
                  <span className="text-base-content/50 font-mono text-xs shrink-0">
                    {item.fileSize != null
                      ? formatKilobytes(item.fileSize)
                      : "—"}
                  </span>
                </div>
                {!isMultiVersion && item.hasDuplicateEpisodes && (
                  <p className="mt-0.5 pl-0.5 text-xs text-base-content/40">
                    One or more episodes have multiple synced versions.
                  </p>
                )}
                {isMultiVersion && (
                  <div className="mt-0.5 flex flex-col">
                    {versions.map((v, i) => {
                      const isLast = i === versions.length - 1;
                      return (
                        <div
                          key={v.mediaId}
                          className="relative flex items-center gap-2 pl-5 py-0.5 text-xs text-base-content/50"
                        >
                          <span className="absolute left-2 top-0 h-1/2 w-px bg-base-content/20" />
                          {!isLast && (
                            <span className="absolute left-2 top-1/2 h-1/2 w-px bg-base-content/20" />
                          )}
                          <span className="absolute left-2 top-1/2 w-3 h-px bg-base-content/20" />
                          <span className="truncate">{versionLabel(v)}</span>
                          <span className="ml-auto font-mono shrink-0">
                            {v.fileSize != null
                              ? formatKilobytes(v.fileSize)
                              : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {hasMultiVersionItems && (
          <p className="mt-1.5 text-xs text-base-content/40">
            Items with multiple versions (shown above) lose all of them here. To
            remove just one, use the{" "}
            <Link
              to="/duplicates"
              search={{ type: "all" }}
              className="link link-primary"
            >
              Duplicates page
            </Link>{" "}
            instead.
          </p>
        )}
        {error != null && (
          <p className="text-error text-sm">
            {error instanceof Error ? error.message : "Delete failed"}
          </p>
        )}
        <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border border-base-300 bg-base-200/40 p-3">
          <input
            type="checkbox"
            className="checkbox checkbox-sm mt-0.5"
            checked={plexOnly}
            onChange={(event) => setPlexOnly(event.target.checked)}
            disabled={pending}
          />
          <span>
            <span className="block text-sm font-medium">
              Delete from Plex only
            </span>
            <span className="block text-xs text-base-content/55">
              Skip mapped Sonarr or Radarr instances. Monitored media may be
              downloaded again.
            </span>
          </span>
        </label>
        <div className="modal-action mt-3">
          <button
            type="button"
            className="btn btn-sm"
            onClick={cancel}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-error gap-2"
            onClick={() => onConfirm(plexOnly ? "plex-only" : "coordinated")}
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
