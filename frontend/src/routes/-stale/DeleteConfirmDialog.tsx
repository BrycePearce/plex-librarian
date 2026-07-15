import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Copy, File, Folder, Info, Trash2 } from "lucide-react";
import type {
  ArrCleanupTarget,
  StaleItem,
  TorrentCleanupTorrent,
} from "../../lib/api";
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
  const coordinatedReady = Boolean(
    preview.data?.coordinatedConfigured &&
      preview.data.items.every((item) => item.arrStatus === "resolved"),
  );
  const arrProblems =
    preview.data?.items.filter((item) => item.arrStatus !== "resolved") ?? [];
  const arrEntries =
    preview.data?.items.flatMap((previewItem) =>
      previewItem.arrTargets.map((target) => ({
        ratingKey: previewItem.ratingKey,
        target,
      }))
    ) ?? [];
  const unmanagedSources =
    preview.data?.items.flatMap((previewItem) =>
      previewItem.status === "resolved" ? [] : previewItem.sources.filter(
        (source) =>
          !previewItem.torrents.some((torrent) => torrent.hash === source.hash),
      ).map((source) => ({ ratingKey: previewItem.ratingKey, source }))
    ) ?? [];
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
        <div className="mt-3 space-y-2 rounded-lg border border-base-300 bg-base-200/35 p-2.5">
          <CompactOption
            label="Delete from Plex only"
            info="Skips mapped Sonarr or Radarr instances. If the title is monitored, Arr may download it again."
            checked={plexOnly}
            disabled={pending}
            onChange={(checked) => {
              setPlexOnly(checked);
              if (checked) setDeleteTorrents(false);
            }}
          />
          {!plexOnly && (
            <CompactOption
              label="Remove from qBittorrent and delete downloaded files"
              info="Removes the verified qBittorrent job and asks qBittorrent to delete its payload. Plex Librarian does not independently delete a saved .torrent file."
              checked={deleteTorrents}
              disabled={pending || preview.isLoading || !cleanupFullyResolved}
              onChange={setDeleteTorrents}
            />
          )}
        </div>

        <PreviewStatus
          loading={preview.isLoading}
          error={preview.isError ? preview.error.message : null}
          plexOnly={plexOnly}
          coordinatedConfigured={preview.data?.coordinatedConfigured ?? false}
          qbitConfigured={preview.data?.configured ?? false}
          arrProblems={preview.data?.coordinatedConfigured
            ? arrProblems.map((problem) => ({
              title: items.find((item) => item.ratingKey === problem.ratingKey)
                ?.title ?? problem.ratingKey,
              reason: problem.arrReason ??
                "managed deletion could not be verified",
            }))
            : []}
          cleanupError={cleanupHasErrors
            ? preview.data?.items
              .filter((item) => item.status === "error")
              .map((item) => item.reason)
              .filter(Boolean)
              .join("; ") ?? null
            : null}
          cleanupUnavailable={cleanupUnavailable.length > 0 &&
              torrents.length > 0
            ? cleanupUnavailable.map((item) =>
              `${
                items.find((candidate) =>
                  candidate.ratingKey === item.ratingKey
                )?.title ??
                  item.ratingKey
              }: ${item.reason ?? "association unavailable"}`
            ).join("; ")
            : null}
          cleanupPreviouslyStarted={cleanupPreviouslyStarted}
          noLiveTorrent={Boolean(
            preview.data?.configured && torrents.length === 0 &&
              !cleanupPreviouslyStarted && !cleanupHasErrors,
          )}
        />

        <DeletionTree
          items={items}
          plexOnly={plexOnly}
          arrEntries={arrEntries}
          torrents={torrents}
          deleteTorrents={deleteTorrents}
          unmanagedSources={unmanagedSources}
          loading={preview.isLoading}
        />
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
            disabled={pending || (!plexOnly && !coordinatedReady)}
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

function InfoTip({ text }: { text: string }) {
  return (
    <span
      className="tooltip tooltip-left inline-flex shrink-0 cursor-help text-base-content/45"
      data-tip={text}
      tabIndex={0}
      aria-label={text}
    >
      <Info className="size-3.5" />
    </span>
  );
}

function CompactOption({
  label,
  info,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  info: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center gap-2 text-sm ${
        disabled ? "opacity-55" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        className="checkbox checkbox-sm"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="font-medium">{label}</span>
      <InfoTip text={info} />
    </label>
  );
}

function PreviewStatus({
  loading,
  error,
  plexOnly,
  coordinatedConfigured,
  qbitConfigured,
  arrProblems,
  cleanupError,
  cleanupUnavailable,
  cleanupPreviouslyStarted,
  noLiveTorrent,
}: {
  loading: boolean;
  error: string | null;
  plexOnly: boolean;
  coordinatedConfigured: boolean;
  qbitConfigured: boolean;
  arrProblems: Array<{ title: string; reason: string }>;
  cleanupError: string | null;
  cleanupUnavailable: string | null;
  cleanupPreviouslyStarted: boolean;
  noLiveTorrent: boolean;
}) {
  if (plexOnly) return null;
  return (
    <div className="mt-2 space-y-1 text-xs">
      {loading && (
        <p className="flex items-center gap-2 text-base-content/50">
          <span className="loading loading-spinner loading-xs" />{" "}
          Verifying deletion paths…
        </p>
      )}
      {error && (
        <p className="text-error">Could not verify deletion paths: {error}</p>
      )}
      {!loading && !error && !coordinatedConfigured && (
        <p className="text-warning">
          No Sonarr or Radarr mapping. Select Plex-only deletion or configure
          one first.
        </p>
      )}
      {arrProblems.map((problem) => (
        <p key={`${problem.title}:${problem.reason}`} className="text-error">
          {problem.title}: {problem.reason}
        </p>
      ))}
      {cleanupError && <p className="text-error">qBittorrent: {cleanupError}
      </p>}
      {cleanupUnavailable && (
        <p className="text-warning">qBittorrent: {cleanupUnavailable}</p>
      )}
      {cleanupPreviouslyStarted && (
        <p className="text-info">
          qBittorrent removal was previously started; select it again to finish
          Arr deletion.
        </p>
      )}
      {noLiveTorrent && (
        <p className="text-base-content/50">
          No associated live qBittorrent job was found.
        </p>
      )}
      {!loading && !error && !qbitConfigured && (
        <p className="text-base-content/45">
          qBittorrent cleanup is unavailable.{"  "}
          <Link to="/settings/sonarr-radarr" className="link link-primary">
            Media connections
          </Link>
        </p>
      )}
    </div>
  );
}

interface TreeFile {
  path: string;
  size: number | null;
}

interface TreeNode {
  name: string;
  size: number | null;
  children: Map<string, TreeNode>;
}

const TREE_FILE_LIMIT = 20;

function buildTree(files: TreeFile[]): TreeNode[] {
  const roots = new Map<string, TreeNode>();
  for (const file of files) {
    const segments = file.path.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0) continue;
    let level = roots;
    segments.forEach((name, index) => {
      const key = name.toLocaleLowerCase();
      let node = level.get(key);
      if (!node) {
        node = { name, size: null, children: new Map() };
        level.set(key, node);
      }
      if (index === segments.length - 1) node.size = file.size;
      level = node.children;
    });
  }
  return [...roots.values()];
}

function TreeNodes(
  { nodes, depth = 0 }: { nodes: TreeNode[]; depth?: number },
) {
  return (
    <ul className={depth === 0 ? "ml-2 border-l border-base-300 pl-3" : "ml-4"}>
      {nodes.map((node) => {
        const children = [...node.children.values()];
        const isFolder = children.length > 0;
        return (
          <li key={`${depth}:${node.name}`} className="py-0.5">
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-base-content/60">
              {isFolder
                ? <Folder className="size-3.5 shrink-0 text-warning/80" />
                : <File className="size-3.5 shrink-0 text-base-content/40" />}
              <span
                className="min-w-0 flex-1 truncate font-mono"
                title={node.name}
              >
                {node.name}
              </span>
              {node.size !== null && (
                <span className="shrink-0 text-[11px] text-base-content/40">
                  {formatKilobytes(node.size / 1000)}
                </span>
              )}
            </div>
            {children.length > 0 && (
              <TreeNodes nodes={children} depth={depth + 1} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PathTreeRoot({
  path,
  source,
  files,
  totalFiles,
  note,
  info,
  warning = false,
}: {
  path: string;
  source: string;
  files?: TreeFile[];
  totalFiles?: number;
  note?: string;
  info?: string;
  warning?: boolean;
}) {
  const visibleFiles = (files ?? []).slice(0, TREE_FILE_LIMIT);
  const hiddenCount = Math.max(
    0,
    (totalFiles ?? files?.length ?? 0) - visibleFiles.length,
  );
  return (
    <div className="py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Folder
          className={`size-4 shrink-0 ${
            warning ? "text-warning" : "text-primary"
          }`}
        />
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {path}
        </span>
        {info && <InfoTip text={info} />}
        <span className="badge badge-ghost badge-xs shrink-0">{source}</span>
      </div>
      {visibleFiles.length > 0 && <TreeNodes nodes={buildTree(visibleFiles)} />}
      {(note || hiddenCount > 0) && (
        <p className="ml-6 mt-0.5 text-[11px] text-base-content/40">
          {[note, hiddenCount > 0 ? `${hiddenCount} more files` : null].filter(
            Boolean,
          ).join(" · ")}
        </p>
      )}
    </div>
  );
}

function managedFiles(target: ArrCleanupTarget): TreeFile[] {
  const files = new Map<string, TreeFile>();
  for (const file of target.mediaFiles ?? []) {
    files.set(file.relativePath.toLocaleLowerCase(), {
      path: file.relativePath,
      size: file.size,
    });
  }
  for (const file of target.extraFiles ?? []) {
    const key = file.relativePath.toLocaleLowerCase();
    if (!files.has(key)) {
      files.set(key, { path: file.relativePath, size: null });
    }
  }
  return [...files.values()];
}

function torrentInfo(torrent: TorrentCleanupTorrent): string {
  return [
    `${torrent.fileCount} file${torrent.fileCount === 1 ? "" : "s"}`,
    formatKilobytes(torrent.size / 1000),
    `seeded ${formatSeedTime(torrent.seedingTime)}`,
    `ratio ${torrent.ratio.toFixed(2)}`,
    torrent.trackerHost ?? "tracker unavailable",
    torrent.completedAt ? `completed ${formatDate(torrent.completedAt)}` : null,
  ].filter(Boolean).join(" · ");
}

function torrentRoot(torrent: TorrentCleanupTorrent): string {
  return torrent.fileCount === 1
    ? torrent.savePath || torrent.contentPath
    : torrent.contentPath ||
      torrent.savePath;
}

function torrentFiles(torrent: TorrentCleanupTorrent): TreeFile[] {
  const rootName = torrent.contentPath.split(/[\\/]+/).filter(Boolean).at(-1)
    ?.toLocaleLowerCase();
  return torrent.files.map((file) => {
    const segments = file.path.split(/[\\/]+/).filter(Boolean);
    const path =
      torrent.fileCount > 1 && segments[0]?.toLocaleLowerCase() === rootName
        ? segments.slice(1).join("/")
        : file.path;
    return { path: path || file.path, size: file.size };
  });
}

function DeletionTree({
  items,
  plexOnly,
  arrEntries,
  torrents,
  deleteTorrents,
  unmanagedSources,
  loading,
}: {
  items: StaleItem[];
  plexOnly: boolean;
  arrEntries: Array<{ ratingKey: string; target: ArrCleanupTarget }>;
  torrents: TorrentCleanupTorrent[];
  deleteTorrents: boolean;
  unmanagedSources: Array<{
    ratingKey: string;
    source: { instanceName: string; hash: string; path: string };
  }>;
  loading: boolean;
}) {
  const remainingTorrents = plexOnly || !deleteTorrents ? torrents : [];
  const hasRemaining = remainingTorrents.length > 0 ||
    unmanagedSources.length > 0;
  return (
    <div className={`mt-3 grid gap-2 ${hasRemaining ? "sm:grid-cols-2" : ""}`}>
      <section className="rounded-lg border border-base-300 bg-base-200/30 p-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-base-content/55">
          Files to be removed
          <InfoTip text="Only verified managed roots and qBittorrent payloads selected above appear here." />
        </div>
        <div className="mt-1 max-h-56 divide-y divide-base-300/60 overflow-y-auto">
          {plexOnly && items.map((item) => (
            <PathTreeRoot
              key={item.ratingKey}
              path={item.title}
              source="Plex"
              note="Underlying media path is not available in this preview"
            />
          ))}
          {!plexOnly && arrEntries.map(({ ratingKey, target }) => {
            const files = managedFiles(target);
            const note = target.type === "sonarr"
              ? "Series contents are removed by Sonarr; the episode list is intentionally omitted"
              : target.mediaFiles === null || target.extraFiles === null
              ? "Some managed file details are unavailable"
              : undefined;
            return (
              <PathTreeRoot
                key={`${ratingKey}:${target.instanceName}:${target.path}`}
                path={target.path ?? target.title}
                source={target.instanceName}
                files={files}
                note={note}
              />
            );
          })}
          {!plexOnly && deleteTorrents &&
            torrents.map((torrent) => (
              <PathTreeRoot
                key={`${torrent.instanceKey}:${torrent.hash}`}
                path={torrentRoot(torrent) || torrent.name}
                source={torrent.instanceName}
                files={torrentFiles(torrent)}
                totalFiles={torrent.fileCount}
                info={torrentInfo(torrent)}
              />
            ))}
          {loading && (
            <p className="flex items-center gap-2 py-3 text-xs text-base-content/45">
              <span className="loading loading-spinner loading-xs" />{" "}
              Loading paths…
            </p>
          )}
          {!loading && !plexOnly && arrEntries.length === 0 && (
            <p className="py-3 text-xs text-base-content/40">
              No verified managed path.
            </p>
          )}
        </div>
      </section>

      {hasRemaining && (
        <section className="rounded-lg border border-warning/30 bg-warning/5 p-2.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-warning">
            Will remain
            <InfoTip text="These paths are not selected or cannot be proven safe to delete automatically." />
          </div>
          <div className="mt-1 max-h-56 divide-y divide-base-300/60 overflow-y-auto">
            {remainingTorrents.map((torrent) => (
              <PathTreeRoot
                key={`${torrent.instanceKey}:${torrent.hash}:remaining`}
                path={torrentRoot(torrent) || torrent.name}
                source={torrent.instanceName}
                note={`${torrent.fileCount} downloaded file${
                  torrent.fileCount === 1 ? "" : "s"
                }; select qBittorrent cleanup to remove`}
                info={torrentInfo(torrent)}
                warning
              />
            ))}
            {unmanagedSources.map(({ ratingKey, source }) => (
              <PathTreeRoot
                key={`${ratingKey}:${source.instanceName}:${source.hash}:${source.path}`}
                path={source.path}
                source="Arr history"
                note="No live qBittorrent job owns this path"
                warning
              />
            ))}
          </div>
        </section>
      )}
    </div>
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
