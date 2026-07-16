import { useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronRight, Copy, File, Folder } from "lucide-react";
import type {
  ArrCleanupFile,
  ArrCleanupTarget,
  DownloadCleanupJob,
  DownloadCleanupPreviewItem,
  StaleItem,
} from "../../lib/api";
import { formatDate, formatKilobytes } from "../../lib/format";
import { InfoTip } from "./InfoTip";
import { plexPreviewPathEntries } from "./plexPreviewPaths";

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

function TreeNodes({ nodes, depth = 0 }: { nodes: TreeNode[]; depth?: number }) {
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
              <span className="min-w-0 flex-1 truncate font-mono" title={node.name}>
                {node.name}
              </span>
              {node.size !== null && (
                <span className="shrink-0 text-[11px] text-base-content/40">
                  {formatKilobytes(node.size / 1000)}
                </span>
              )}
            </div>
            {children.length > 0 && <TreeNodes nodes={children} depth={depth + 1} />}
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
  const [copied, setCopied] = useState(false);
  const visibleFiles = (files ?? []).slice(0, TREE_FILE_LIMIT);
  const hiddenCount = Math.max(
    0,
    (totalFiles ?? files?.length ?? 0) - visibleFiles.length,
  );
  return (
    <div className="py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Folder
          className={`size-4 shrink-0 ${warning ? "text-warning" : "text-primary"}`}
        />
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {path}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-xs size-6 shrink-0 p-0"
          aria-label={copied ? "Path copied" : `Copy path ${path}`}
          title={copied ? "Copied" : "Copy path"}
          onClick={() => {
            void copyText(path).then(() => {
              setCopied(true);
              globalThis.setTimeout(() => setCopied(false), 1_500);
            });
          }}
        >
          {copied
            ? <Check className="size-3.5 text-success" />
            : <Copy className="size-3.5 text-base-content/50" />}
        </button>
        {info && <InfoTip text={info} />}
        <span className="badge badge-ghost badge-xs shrink-0">{source}</span>
      </div>
      {visibleFiles.length > 0 && <TreeNodes nodes={buildTree(visibleFiles)} />}
      {(note || hiddenCount > 0) && (
        <p className="ml-6 mt-0.5 text-[11px] text-base-content/40">
          {[note, hiddenCount > 0 ? `${hiddenCount} more files` : null].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Clipboard access can be unavailable when the app is served over HTTP.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
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
    if (!files.has(key)) files.set(key, { path: file.relativePath, size: null });
  }
  return [...files.values()];
}

function downloadJobInfo(job: DownloadCleanupJob): string {
  return [
    `${job.fileCount} file${job.fileCount === 1 ? "" : "s"}`,
    formatKilobytes(job.size / 1000),
    `seeded ${formatSeedTime(job.seedingTime)}`,
    job.ratio === null ? "ratio unavailable" : `ratio ${job.ratio.toFixed(2)}`,
    job.trackerHost ?? "tracker unavailable",
    job.completedAt ? `completed ${formatDate(job.completedAt)}` : null,
  ].filter(Boolean).join(" · ");
}

function downloadJobRoot(job: DownloadCleanupJob): string {
  return job.fileCount === 1 ? job.savePath || job.contentPath : job.contentPath || job.savePath;
}

function downloadJobFiles(job: DownloadCleanupJob): TreeFile[] {
  const rootSegments = job.contentPath.split(/[\\/]+/).filter(Boolean);
  const rootName = rootSegments[rootSegments.length - 1]?.toLocaleLowerCase();
  return job.files.map((file) => {
    const segments = file.path.split(/[\\/]+/).filter(Boolean);
    const path = job.fileCount > 1 && segments[0]?.toLocaleLowerCase() === rootName
      ? segments.slice(1).join("/")
      : file.path;
    return { path: path || file.path, size: file.size };
  });
}

function CollapsiblePathSection({
  title,
  count,
  info,
  warning = false,
  children,
}: {
  title: string;
  count: number | null;
  info: string;
  warning?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      className={`group rounded-lg border ${
        warning ? "border-warning/30 bg-warning/5" : "border-base-300 bg-base-200/30"
      }`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 p-2.5 text-sm font-medium marker:hidden [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-base-content/40 transition-transform group-open:rotate-90" />
        <span className={warning ? "text-warning" : "text-base-content/70"}>{title}</span>
        <InfoTip text={info} />
        {count === null
          ? <span className="loading loading-spinner loading-xs ml-auto text-base-content/40" />
          : (
            <span className="ml-auto text-xs font-normal text-base-content/40">
              {count} {count === 1 ? "path" : "paths"}
            </span>
          )}
      </summary>
      <div className="mx-2.5 max-h-56 divide-y divide-base-300/60 overflow-y-auto border-t border-base-300/60 pb-1">
        {children}
      </div>
    </details>
  );
}

export function DeletionTree({
  items,
  plexPreviews,
  deleteFromArr,
  arrEntries,
  downloadJobs,
  orphanFiles,
  cleanupDownloads,
  unmanagedSources,
  retainedPaths,
  loading,
}: {
  items: StaleItem[];
  plexPreviews: ReadonlyMap<string, DownloadCleanupPreviewItem>;
  deleteFromArr: boolean;
  arrEntries: Array<{ ratingKey: string; target: ArrCleanupTarget }>;
  downloadJobs: DownloadCleanupJob[];
  orphanFiles: ArrCleanupFile[];
  cleanupDownloads: boolean;
  unmanagedSources: Array<{
    ratingKey: string;
    source: {
      instanceName: string;
      downloadId: string;
      path: string;
      reason?: string;
    };
  }>;
  retainedPaths: Array<{ path: string; reason: string }>;
  loading: boolean;
}) {
  const arrRatingKeys = new Set(arrEntries.map((entry) => entry.ratingKey));
  const plexFallbackItems = deleteFromArr
    ? items.filter((item) => !arrRatingKeys.has(item.ratingKey))
    : items;
  const plexFallbackEntries = plexPreviewPathEntries(plexFallbackItems, plexPreviews);
  const hasRemaining = cleanupDownloads &&
    (unmanagedSources.length > 0 || retainedPaths.length > 0);
  const removalPathCount = deleteFromArr
    ? arrEntries.length + plexFallbackEntries.length +
      (cleanupDownloads ? downloadJobs.length + orphanFiles.length : 0)
    : plexFallbackEntries.length;
  return (
    <div className="mt-3 space-y-2">
      <CollapsiblePathSection
        title="Files to be removed"
        count={loading ? null : removalPathCount}
        info="Shows paths reported by Plex and configured deletion services. Plex paths are informational and are never used to authorize direct filesystem deletion."
      >
        {plexFallbackEntries.map(({ item, path, note }, index) => (
          <PathTreeRoot
            key={`${item.ratingKey}:${path}:${index}`}
            path={path}
            source="Plex"
            note={note ??
              (deleteFromArr
                ? "No verified Arr destination; this item uses Plex-only deletion"
                : undefined)}
          />
        ))}
        {deleteFromArr && arrEntries.map(({ ratingKey, target }) => {
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
        {deleteFromArr && cleanupDownloads && downloadJobs.map((job) => (
          <PathTreeRoot
            key={`${job.instanceKey}:${job.jobId}`}
            path={downloadJobRoot(job) || job.name}
            source={job.instanceName}
            files={downloadJobFiles(job)}
            totalFiles={job.fileCount}
            info={downloadJobInfo(job)}
          />
        ))}
        {deleteFromArr && cleanupDownloads && orphanFiles.map((file) => (
          <PathTreeRoot
            key={`hardlink:${file.path}`}
            path={file.path}
            source="Verified hardlink"
            files={[{
              path: file.path.split(/[\\/]+/).slice(-1)[0] ?? file.path,
              size: file.size,
            }]}
            note="Reverified immediately before removal"
          />
        ))}
        {loading && (
          <p className="flex items-center gap-2 py-3 text-xs text-base-content/45">
            <span className="loading loading-spinner loading-xs" /> Loading paths…
          </p>
        )}
      </CollapsiblePathSection>

      {hasRemaining && (
        <CollapsiblePathSection
          title="Not automatically removed"
          count={unmanagedSources.length + retainedPaths.length}
          info="These historical paths are not automatically removed because ownership cannot be proven safely."
          warning
        >
          {unmanagedSources.map(({ ratingKey, source }) => (
            <PathTreeRoot
              key={`${ratingKey}:${source.instanceName}:${source.downloadId}:${source.path}`}
              path={source.path}
              source="Arr history"
              note={source.reason ?? "Ownership could not be verified"}
              warning
            />
          ))}
          {retainedPaths.map((path) => (
            <PathTreeRoot
              key={`retained:${path.path}`}
              path={path.path}
              source="Filesystem"
              note={path.reason}
              warning
            />
          ))}
        </CollapsiblePathSection>
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
