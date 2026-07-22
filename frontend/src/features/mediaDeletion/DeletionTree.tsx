import { useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy, File, Folder, X } from "lucide-react";
import type {
  ArrCleanupTarget,
  DownloadCleanupJob,
  DownloadCleanupPreviewItem,
} from "../../lib/api.ts";
import { formatDate, formatKilobytes } from "../../lib/format.ts";
import { ServiceIcon } from "../../components/ServiceIcons.tsx";
import type { ServiceIconName } from "../../components/ServiceIcons.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { PlannedServiceExceptions } from "./DeletionPlanSummary.tsx";
import { plexPreviewPathEntries } from "./plexPreviewPaths.ts";
import type { WholeItemDeletionCandidate } from "./types.ts";

interface TreeFile {
  path: string;
  size: number | null;
  detail?: string;
  folder?: boolean;
}

interface TreeNode {
  name: string;
  size: number | null;
  detail?: string;
  folder?: boolean;
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
      if (index === segments.length - 1) {
        node.size = file.size;
        node.detail = file.detail;
        node.folder = file.folder;
      }
      level = node.children;
    });
  }
  return [...roots.values()];
}

function TreeNodes(
  { nodes, depth = 0 }: { nodes: TreeNode[]; depth?: number },
) {
  return (
    <ul className="ml-1.5">
      {nodes.map((node) => {
        const children = [...node.children.values()];
        const isFolder = node.folder === true || children.length > 0;
        return (
          <li
            key={`${depth}:${node.name}`}
            className="relative py-px pl-3 before:absolute before:left-0 before:top-0 before:h-full before:border-l before:border-base-content/20 after:absolute after:left-0 after:top-2 after:w-2.5 after:border-t after:border-base-content/20 last:before:h-2"
          >
            <div className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-base-content/55">
              {isFolder
                ? <Folder className="size-3 shrink-0 text-warning/75" />
                : <File className="size-3 shrink-0 text-base-content/35" />}
              <span
                className="min-w-0 flex-1 truncate font-mono"
                title={node.name}
              >
                {node.name}
              </span>
              {node.detail && (
                <span className="shrink-0 text-[10px] text-base-content/35">
                  {node.detail}
                </span>
              )}
              {node.size !== null && (
                <span className="shrink-0 text-[10px] text-base-content/35">
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

export function PathTreeRoot({
  path,
  source,
  marks,
  files,
  totalFiles,
  note,
  info,
  itemName = "file",
  warning = false,
}: {
  path: string;
  source?: string;
  marks?: ReactNode;
  files?: TreeFile[];
  totalFiles?: number;
  note?: string;
  info?: string;
  itemName?: string;
  warning?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const visibleFiles = (files ?? []).slice(0, TREE_FILE_LIMIT);
  const hiddenCount = Math.max(
    0,
    (totalFiles ?? files?.length ?? 0) - visibleFiles.length,
  );
  return (
    <div className="relative py-0.5 pl-3 before:absolute before:left-0 before:top-0 before:h-full before:border-l before:border-base-content/20 after:absolute after:left-0 after:top-2.5 after:w-2.5 after:border-t after:border-base-content/20 last:before:h-2.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-5">
        <Folder
          className={`size-3.5 shrink-0 ${warning ? "text-warning" : "text-primary"}`}
        />
        <span className="min-w-0 truncate font-mono" title={path}>
          {path}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-xs size-5 min-h-0 shrink-0 p-0"
          aria-label={copyStatus === "copied"
            ? "Path copied"
            : copyStatus === "failed"
            ? "Could not copy path"
            : `Copy path ${path}`}
          title={copyStatus === "copied"
            ? "Copied"
            : copyStatus === "failed"
            ? "Copy failed"
            : "Copy path"}
          onClick={(event) => {
            const trigger = event.currentTarget;
            void copyText(path, trigger).then(() => {
              setCopyStatus("copied");
              globalThis.setTimeout(() => setCopyStatus("idle"), 1_500);
            }).catch(() => {
              setCopyStatus("failed");
              globalThis.setTimeout(() => setCopyStatus("idle"), 2_000);
            });
          }}
        >
          {copyStatus === "copied"
            ? <Check className="size-3 text-success" />
            : copyStatus === "failed"
            ? <X className="size-3 text-error" />
            : <Copy className="size-3 text-base-content/45" />}
        </button>
        {info && <InfoTip text={info} />}
        {(marks || source) && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {marks}
            {source && <span className="badge badge-ghost badge-xs shrink-0">{source}</span>}
          </span>
        )}
      </div>
      {visibleFiles.length > 0 && <TreeNodes nodes={buildTree(visibleFiles)} />}
      {(note || hiddenCount > 0) && (
        <p className="ml-5 text-[10px] leading-4 text-base-content/35">
          {[
            note,
            hiddenCount > 0
              ? `${hiddenCount} more ${itemName}${hiddenCount === 1 ? "" : "s"}`
              : null,
          ].filter(
            Boolean,
          ).join(" · ")}
        </p>
      )}
    </div>
  );
}

async function copyText(
  value: string,
  trigger: HTMLButtonElement,
): Promise<void> {
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
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  // A modal <dialog> makes nodes outside itself inert. Keep the fallback
  // selection inside the dialog so copying still works on insecure HTTP
  // origins where navigator.clipboard is unavailable (common on Unraid).
  const container = trigger.closest("dialog[open]") ?? document.body;
  container.appendChild(textarea);
  let copied = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
    trigger.focus({ preventScroll: true });
  }
  if (!copied) throw new Error("Browser rejected the copy command");
}

export function managedFiles(target: ArrCleanupTarget): TreeFile[] {
  if (target.type === "sonarr") {
    return (target.seasons ?? []).map((season) => ({
      path: season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`,
      size: season.size,
      detail: season.episodeFileCount === null
        ? undefined
        : `${season.episodeFileCount} file${season.episodeFileCount === 1 ? "" : "s"}`,
      folder: true,
    }));
  }
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

export function downloadJobInfo(job: DownloadCleanupJob): string {
  return [
    `${job.fileCount} file${job.fileCount === 1 ? "" : "s"}`,
    formatKilobytes(job.size / 1000),
    `seeded ${formatSeedTime(job.seedingTime)}`,
    job.ratio === null ? "ratio unavailable" : `ratio ${job.ratio.toFixed(2)}`,
    job.trackerHost ?? "tracker unavailable",
    job.completedAt ? `completed ${formatDate(job.completedAt)}` : null,
  ].filter(Boolean).join(" · ");
}

export function downloadJobRoot(job: DownloadCleanupJob): string {
  return job.fileCount === 1 ? job.savePath || job.contentPath : job.contentPath || job.savePath;
}

export function downloadJobFiles(job: DownloadCleanupJob): TreeFile[] {
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

export function ActiveServiceMark({
  service,
  label,
}: {
  service: ServiceIconName;
  label: string;
}) {
  const color = service === "plex"
    ? "bg-warning/15 text-warning"
    : service === "sonarr"
    ? "bg-warning/10 text-warning"
    : "bg-info/10 text-info";
  return (
    <span
      className={`inline-flex size-5 shrink-0 items-center justify-center rounded p-0.5 ${color}`}
      title={label}
      role="img"
      aria-label={label}
    >
      <ServiceIcon service={service} className="size-3.5" />
    </span>
  );
}

export function DeletionServiceMarks({
  item,
  preview,
  deleteFromArr,
  cleanupDownloads,
}: {
  item: WholeItemDeletionCandidate;
  preview?: DownloadCleanupPreviewItem;
  deleteFromArr: boolean;
  cleanupDownloads: boolean;
}) {
  const arrService = item.type === "show" ? "sonarr" : "radarr";
  const arrActive = deleteFromArr && preview?.arrStatus === "resolved" &&
    preview.arrTargets.length > 0;
  const qbitActive = deleteFromArr && cleanupDownloads &&
    preview?.status === "resolved" && preview.downloadJobs.length > 0;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <ActiveServiceMark service="plex" label="Plex deletion" />
      {arrActive && (
        <ActiveServiceMark
          service={arrService}
          label={`${arrService === "sonarr" ? "Sonarr" : "Radarr"} deletion`}
        />
      )}
      {qbitActive && (
        <ActiveServiceMark
          service="qbittorrent"
          label="qBittorrent download cleanup"
        />
      )}
      <PlannedServiceExceptions
        deleteFromArr={deleteFromArr}
        arrService={arrService}
        arrStatus={preview?.arrStatus}
        arrReason={preview?.arrReason}
        downloadJobCount={cleanupDownloads && preview?.status === "resolved"
          ? preview.downloadJobs.length
          : 0}
        hardlinkFileCount={cleanupDownloads && preview?.status === "resolved"
          ? preview.orphanFiles.length
          : 0}
        downloadCleanupResuming={Boolean(
          cleanupDownloads && preview?.status === "resolved" &&
            preview.downloadJobs.length === 0 &&
            preview.orphanFiles.length === 0,
        )}
        cleanupDownloads={cleanupDownloads}
        cleanupStatus={preview?.status}
        cleanupReason={preview?.reason}
      />
    </span>
  );
}

export function AdvancedDeletionTree({
  items,
  plexPreviews,
  deleteFromArr,
  cleanupDownloads,
  loading,
}: {
  items: WholeItemDeletionCandidate[];
  plexPreviews: ReadonlyMap<string, DownloadCleanupPreviewItem>;
  deleteFromArr: boolean;
  cleanupDownloads: boolean;
  loading: boolean;
}) {
  const plans = items.map((item) => {
    const preview = plexPreviews.get(item.ratingKey);
    const arrTargets = deleteFromArr && preview?.arrStatus === "resolved" ? preview.arrTargets : [];
    const plexEntries = arrTargets.length === 0 ? plexPreviewPathEntries([item], plexPreviews) : [];
    const downloadJobs = deleteFromArr && cleanupDownloads &&
        preview?.status === "resolved"
      ? preview.downloadJobs
      : [];
    const orphanFiles = deleteFromArr && cleanupDownloads &&
        preview?.status === "resolved"
      ? preview.orphanFiles
      : [];
    return { item, arrTargets, plexEntries, downloadJobs, orphanFiles };
  });
  const pathCount = plans.reduce(
    (count, plan) =>
      count + plan.arrTargets.length + plan.plexEntries.length +
      plan.downloadJobs.length + plan.orphanFiles.length,
    0,
  );

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-base-300 bg-base-200/25">
      <div className="flex h-7 items-center gap-1.5 border-b border-base-300/70 px-2.5 text-[11px] text-base-content/45">
        <span className="font-medium text-base-content/60">Deletion tree</span>
        <InfoTip text="Shows paths reported by Plex and configured deletion services. Plex paths are informational and never authorize direct filesystem deletion." />
        {loading
          ? <span className="loading loading-spinner loading-xs ml-auto" />
          : (
            <span className="ml-auto font-mono">
              {pathCount} {pathCount === 1 ? "path" : "paths"}
            </span>
          )}
      </div>
      <div className="max-h-72 overflow-y-auto px-2.5 py-1">
        {plans.map((plan) => {
          const hasPaths = plan.arrTargets.length > 0 ||
            plan.plexEntries.length > 0 || plan.downloadJobs.length > 0 ||
            plan.orphanFiles.length > 0;
          return (
            <section
              key={plan.item.ratingKey}
              className="border-b border-base-300/50 py-1 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-2 text-xs leading-5">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span
                    className="min-w-0 flex-1 truncate font-semibold"
                    title={plan.item.title}
                  >
                    {plan.item.title}
                  </span>
                  <DeletionServiceMarks
                    item={plan.item}
                    preview={plexPreviews.get(plan.item.ratingKey)}
                    deleteFromArr={deleteFromArr}
                    cleanupDownloads={cleanupDownloads}
                  />
                </div>
                <span className="shrink-0 font-mono text-[10px] text-base-content/35">
                  {plan.item.fileSize == null ? "—" : formatKilobytes(plan.item.fileSize)}
                </span>
              </div>
              <div className="ml-1.5">
                {plan.plexEntries.map(({ path, note }, index) => (
                  <PathTreeRoot
                    key={`plex:${path}:${index}`}
                    path={path}
                    source="Plex"
                    note={note ??
                      (deleteFromArr
                        ? "No verified Arr destination; Plex-only deletion"
                        : undefined)}
                  />
                ))}
                {plan.arrTargets.map((target) => {
                  const note = target.type === "sonarr"
                    ? "Season summaries reported by Sonarr; individual episodes omitted"
                    : target.mediaFiles === null || target.extraFiles === null
                    ? "Some managed file details are unavailable"
                    : undefined;
                  return (
                    <PathTreeRoot
                      key={`arr:${target.instanceName}:${target.path}`}
                      path={target.path ?? target.title}
                      source={target.instanceName}
                      files={managedFiles(target)}
                      itemName={target.type === "sonarr" ? "season" : "file"}
                      note={note}
                    />
                  );
                })}
                {plan.downloadJobs.map((job) => (
                  <PathTreeRoot
                    key={`job:${job.instanceKey}:${job.jobId}`}
                    path={downloadJobRoot(job) || job.name}
                    source={job.instanceName}
                    files={downloadJobFiles(job)}
                    totalFiles={job.fileCount}
                    info={downloadJobInfo(job)}
                  />
                ))}
                {plan.orphanFiles.map((file) => (
                  <PathTreeRoot
                    key={`hardlink:${file.path}`}
                    path={file.path}
                    source="Hardlink"
                    files={[{
                      path: file.path.split(/[\\/]+/).slice(-1)[0] ?? file.path,
                      size: file.size,
                    }]}
                    note="Reverified before removal"
                  />
                ))}
                {!loading && !hasPaths && (
                  <p className="py-0.5 text-[10px] text-base-content/35">
                    No path details reported
                  </p>
                )}
              </div>
            </section>
          );
        })}
        {loading && (
          <p className="flex items-center gap-2 py-2 text-[11px] text-base-content/40">
            <span className="loading loading-spinner loading-xs" /> Loading paths…
          </p>
        )}
      </div>
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
