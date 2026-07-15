import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Clock3,
  Copy,
  Download,
  Radio,
  Trash2,
} from "lucide-react";
import type { StaleItem } from "../../lib/api";
import { api } from "../../lib/api";
import { formatDate, formatKilobytes } from "../../lib/format";
import { versionLabel } from "../../lib/mediaVersion";
import "../../components/dataSurfaces.css";

export function DeleteConfirmDialog({
  dialogRef,
  libraryKey,
  items,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  libraryKey: string;
  items: StaleItem[];
  pending: boolean;
  error: unknown;
  onConfirm: (
    mode: "coordinated" | "plex-only",
    deleteTorrents: boolean,
  ) => void;
  onCancel: () => void;
}) {
  const [plexOnly, setPlexOnly] = useState(false);
  const [deleteTorrents, setDeleteTorrents] = useState(false);
  const ratingKeys = useMemo(
    () => items.map((item) => item.ratingKey),
    [items],
  );
  const preview = useQuery({
    queryKey: ["torrent-cleanup-preview", libraryKey, ratingKeys],
    queryFn: () => api.libraries.torrentCleanupPreview(libraryKey, ratingKeys),
    enabled: ratingKeys.length > 0,
    staleTime: 15_000,
    retry: false,
  });
  const torrents = preview.data?.items.flatMap((item) => item.torrents) ?? [];
  const cleanupHasErrors =
    preview.data?.items.some((item) => item.status === "error") ?? false;
  const cleanupUnavailable =
    preview.data?.items.filter((item) => item.status === "unavailable") ?? [];
  const cleanupFullyResolved =
    preview.data?.items.every((item) => item.status === "resolved") ?? false;
  const cleanupPreviouslyStarted = cleanupFullyResolved &&
    torrents.length === 0;
  useEffect(() => {
    setDeleteTorrents(false);
  }, [libraryKey, ratingKeys.join("|")]);
  const cancel = () => {
    setPlexOnly(false);
    setDeleteTorrents(false);
    onCancel();
  };
  const totalSize = items.reduce((sum, i) => sum + (i.fileSize ?? 0), 0);
  // Deleting here removes every synced Media version of an item, not just a redundant
  // one — surfaced per-item below (a full version tree for movies, a lighter indicator
  // for shows) rather than a separate warning callout. See Duplicate detection in
  // CLAUDE.md. Movies carry per-version detail via `versions`; shows only carry the
  // existence flag `hasDuplicateEpisodes` (episode_media_versions isn't rolled up
  // per-show) — same signal StaleItemRow's badge already uses.
  const hasMultiVersionItems = items.some(
    (i) => (i.versions?.length ?? 0) >= 2 || i.hasDuplicateEpisodes === true,
  );

  return (
    <dialog ref={dialogRef} className="modal" onClose={cancel}>
      <div className="modal-box polished-modal max-w-2xl">
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
        {!plexOnly && (
          <div className="mt-3 rounded-lg border border-base-300 bg-base-200/40 p-3">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="checkbox checkbox-sm mt-0.5"
                checked={deleteTorrents}
                onChange={(event) => setDeleteTorrents(event.target.checked)}
                disabled={pending || preview.isLoading || !cleanupFullyResolved}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  Remove associated qBittorrent data
                </span>
                <span className="block text-xs text-base-content/55">
                  Stop and remove verified torrents, delete their download
                  payloads, then remove the library files through Sonarr or
                  Radarr.
                </span>
              </span>
            </label>

            {preview.isLoading && (
              <div className="mt-2 flex items-center gap-2 text-xs text-base-content/50">
                <span className="loading loading-spinner loading-xs" />{" "}
                Looking up Arr import history and qBittorrent…
              </div>
            )}
            {preview.isError && (
              <p className="mt-2 text-xs text-error">{preview.error.message}</p>
            )}
            {preview.data && !preview.data.configured && (
              <p className="mt-2 text-xs text-base-content/55">
                Connect qBittorrent under{" "}
                <Link
                  to="/settings/sonarr-radarr"
                  className="link link-primary"
                >
                  Settings → Media connections
                </Link>{" "}
                to enable download cleanup.
              </p>
            )}
            {preview.data?.configured &&
              torrents.length === 0 &&
              !cleanupPreviouslyStarted &&
              !cleanupHasErrors && (
              <p className="mt-2 text-xs text-base-content/55">
                No live qBittorrent torrent could be verified from retained Arr
                import history. The library deletion is still available.
              </p>
            )}
            {cleanupPreviouslyStarted && (
              <p className="mt-2 text-xs text-info">
                Torrent removal was previously started and the torrent is now
                absent. Select this option again to finish the Sonarr or Radarr
                deletion.
              </p>
            )}
            {cleanupHasErrors && (
              <p className="mt-2 text-xs text-error">
                Torrent cleanup is unavailable because a configured service
                could not be checked: {preview.data?.items
                  .filter((item) => item.status === "error")
                  .map((item) =>
                    item.reason
                  )
                  .filter(Boolean)
                  .join("; ")}
              </p>
            )}
            {cleanupUnavailable.length > 0 && torrents.length > 0 && (
              <div className="mt-2 text-xs text-warning">
                <p>
                  Torrent cleanup is disabled because it could not be verified
                  for every selected item:
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {cleanupUnavailable.map((item) => (
                    <li key={item.ratingKey}>
                      {items.find(
                        (candidate) => candidate.ratingKey === item.ratingKey,
                      )?.title ?? item.ratingKey}
                      : {item.reason ?? "association unavailable"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {torrents.length > 0 && (
              <div className="mt-3 max-h-44 space-y-2 overflow-y-auto">
                {torrents.map((torrent) => (
                  <div
                    key={`${torrent.instanceKey}:${torrent.hash}`}
                    className="rounded-md border border-base-300/70 bg-base-100/45 p-2.5 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <Download className="size-3.5 shrink-0 text-primary" />
                      <strong className="min-w-0 flex-1 truncate">
                        {torrent.name}
                      </strong>
                      <span className="badge badge-ghost badge-xs">
                        {torrent.state}
                      </span>
                    </div>
                    <div className="mt-1.5 grid gap-x-4 gap-y-1 text-base-content/55 sm:grid-cols-2">
                      <span>
                        <Clock3 className="mr-1 inline size-3" />
                        Seeded {formatSeedTime(torrent.seedingTime)}
                      </span>
                      <span>
                        Ratio {torrent.ratio.toFixed(2)} ·{" "}
                        {formatKilobytes(torrent.uploaded / 1000)} uploaded
                      </span>
                      <span>
                        {formatKilobytes(torrent.size / 1000)} ·{" "}
                        {torrent.fileCount} file
                        {torrent.fileCount === 1 ? "" : "s"}
                      </span>
                      <span>
                        {torrent.completedAt
                          ? `Completed ${formatDate(torrent.completedAt)}`
                          : "Completion date unavailable"}
                      </span>
                      <span className="truncate" title={torrent.contentPath}>
                        {torrent.contentPath || torrent.savePath}
                      </span>
                      <span>
                        <Radio className="mr-1 inline size-3" />
                        {torrent.trackerHost ?? "Tracker unavailable"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
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
            onClick={() => onConfirm(
              plexOnly ? "plex-only" : "coordinated",
              !plexOnly && deleteTorrents,
            )}
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

function formatSeedTime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days >= 365) {
    const years = Math.floor(days / 365);
    const remainingMonths = Math.floor((days % 365) / 30);
    return `${years}y${remainingMonths > 0 ? ` ${remainingMonths}mo` : ""}`;
  }
  if (days >= 30) return `${Math.floor(days / 30)}mo ${days % 30}d`;
  if (days > 0) return `${days}d`;
  const hours = Math.floor(seconds / 3600);
  return hours > 0 ? `${hours}h` : `${Math.floor(seconds / 60)}m`;
}
