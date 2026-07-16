import { useEffect, useMemo, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  File,
  Folder,
  Info,
  Trash2,
  X,
} from "lucide-react";
import { HoverPopover } from "../../components/HoverPopover";
import { ServiceIcon } from "../../components/ServiceIcons";
import type { ServiceIconName } from "../../components/ServiceIcons";
import type {
  ArrCleanupFile,
  ArrCleanupTarget,
  DownloadCleanupJob,
  StaleItem,
} from "../../lib/api";
import { api } from "../../lib/api";
import { formatDate, formatKilobytes } from "../../lib/format";
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
  onConfirm: (plan: {
    coordinatedRatingKeys: string[];
    cleanupDownloads: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const [deleteFromArr, setDeleteFromArr] = useState(true);
  const [cleanupDownloads, setCleanupDownloads] = useState(false);
  const ratingKeys = useMemo(
    () => items.map((item) => item.ratingKey),
    [items],
  );
  const preview = useQuery({
    queryKey: ["download-cleanup-preview", libraryKey, ratingKeys],
    queryFn: () => api.libraries.downloadCleanupPreview(libraryKey, ratingKeys),
    enabled: ratingKeys.length > 0,
    staleTime: 15_000,
    retry: false,
  });
  const previewByRatingKey = useMemo(
    () =>
      new Map(preview.data?.items.map((item) => [item.ratingKey, item]) ?? []),
    [preview.data],
  );
  const cleanupEligibleItems =
    preview.data?.items.filter((item) => item.status === "resolved") ?? [];
  const downloadJobs = [...new Map(
    cleanupEligibleItems.flatMap((item) => item.downloadJobs).map((job) => [
      `${job.instanceKey}:${job.jobId}`,
      job,
    ]),
  ).values()];
  const orphanFiles = [...new Map(
    cleanupEligibleItems.flatMap((item) => item.orphanFiles).map((
      file,
    ) => [file.path, file]),
  ).values()];
  const cleanupEligibleCount = cleanupEligibleItems.length;
  const coordinatedRatingKeys = preview.data?.coordinatedConfigured
    ? preview.data.items.filter((item) => item.arrStatus === "resolved").map((item) =>
      item.ratingKey
    )
    : [];
  const arrProblems =
    preview.data?.items.filter((item) => item.arrStatus !== "resolved") ?? [];
  const arrEntries =
    preview.data?.items.flatMap((previewItem) =>
      previewItem.arrStatus === "resolved"
        ? previewItem.arrTargets.map((target) => ({
          ratingKey: previewItem.ratingKey,
          target,
        }))
        : []
    ) ?? [];
  const arrService = items[0]?.type === "show" ? "sonarr" : "radarr";
  const arrLabel = arrService === "sonarr" ? "Sonarr" : "Radarr";
  const unmanagedSources =
    preview.data?.items.flatMap((previewItem) =>
      previewItem.sources.filter(
        (source) => source.verification === "unverified",
      ).map((source) => ({ ratingKey: previewItem.ratingKey, source }))
    ) ?? [];
  const retainedPaths = [...new Map(
    (preview.data?.items ?? []).flatMap((item) => item.retainedPaths).map((
      path,
    ) => [path.path, path]),
  ).values()];
  useEffect(() => {
    setDeleteFromArr(true);
    setCleanupDownloads(false);
  }, [libraryKey, ratingKeys.join("|")]);
  useEffect(() => {
    if (preview.data && !preview.data.coordinatedConfigured) {
      setDeleteFromArr(false);
    }
  }, [preview.data]);
  useEffect(() => {
    if (cleanupEligibleCount === 0) setCleanupDownloads(false);
  }, [cleanupEligibleCount]);
  const cancel = () => {
    setDeleteFromArr(preview.data?.coordinatedConfigured ?? true);
    setCleanupDownloads(false);
    onCancel();
  };
  const totalSize = items.reduce((sum, i) => sum + (i.fileSize ?? 0), 0);
  // Deleting here removes every synced Media version, not just one redundant copy.
  // Movies carry an exact version count; shows only carry an existence flag because
  // episode media versions are not rolled up per show. Keep both signals compact so a
  // page-sized selection remains scannable.
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
          <span className="font-semibold text-base-content">
            {formatKilobytes(totalSize)}
          </span>{" "}
          will be permanently removed. This cannot be undone.
        </p>
        <ul className="mt-3 max-h-56 overflow-y-auto text-sm py-1 divide-y divide-base-300/50 rounded-lg border border-base-300 bg-base-200/40">
          {items.map((item) => {
            const versions = item.versions ?? [];
            const isMultiVersion = versions.length >= 2;
            const previewItem = previewByRatingKey.get(item.ratingKey);
            return (
              <li key={item.ratingKey} className="px-3 py-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate min-w-0 flex-1 flex items-center gap-1.5">
                    <span className="truncate">{item.title}</span>
                    {isMultiVersion && (
                      <span className="badge badge-warning badge-xs shrink-0">
                        {versions.length} versions
                      </span>
                    )}
                    {!isMultiVersion && item.hasDuplicateEpisodes && (
                      <Copy
                        className="w-3 h-3 text-warning shrink-0"
                        aria-label="Has duplicate episodes"
                        title="One or more episodes have multiple synced versions"
                      />
                    )}
                  </span>
                  <PlannedServiceIcons
                    deleteFromArr={deleteFromArr}
                    arrService={arrService}
                    arrStatus={previewItem?.arrStatus}
                    arrReason={previewItem?.arrReason}
                    arrTargets={previewItem?.arrStatus === "resolved"
                      ? previewItem.arrTargets
                      : []}
                    downloadJobCount={cleanupDownloads &&
                        previewItem?.status === "resolved"
                      ? previewItem.downloadJobs.length
                      : 0}
                    hardlinkFileCount={cleanupDownloads &&
                        previewItem?.status === "resolved"
                      ? previewItem.orphanFiles.length
                      : 0}
                    downloadCleanupResuming={Boolean(
                      cleanupDownloads && previewItem?.status === "resolved" &&
                        previewItem.downloadJobs.length === 0 &&
                        previewItem.orphanFiles.length === 0,
                    )}
                    cleanupDownloads={cleanupDownloads}
                    cleanupStatus={previewItem?.status}
                    cleanupReason={previewItem?.reason}
                  />
                  <span className="text-base-content/50 font-mono text-xs shrink-0">
                    {item.fileSize != null
                      ? formatKilobytes(item.fileSize)
                      : "—"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        {hasMultiVersionItems && (
          <p className="mt-1.5 text-xs text-base-content/40">
            Items marked with multiple versions lose all of them here. To remove
            just one, use the{" "}
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
        <DestinationOptions
          arrService={arrService}
          arrLabel={arrLabel}
          arrCount={coordinatedRatingKeys.length}
          totalCount={items.length}
          deleteFromArr={deleteFromArr}
          arrDisabled={pending || preview.isLoading ||
            !preview.data?.coordinatedConfigured}
          onArrChange={(checked) => {
            setDeleteFromArr(checked);
            if (!checked) setCleanupDownloads(false);
          }}
          cleanupDownloads={cleanupDownloads}
          cleanupCount={cleanupEligibleCount}
          cleanupInfo={cleanupEligibleCount > 0
            ? `Applies to ${cleanupEligibleCount} of ${items.length} selected items with a verified live download job or hardlinked source file.`
            : preview.data?.downloadClientsConfigured
            ? "No selected items have a verified live qBittorrent job or hardlinked source file."
            : "Connect qBittorrent or configure orphan cleanup path mappings under Media connections."}
          cleanupDisabled={pending || preview.isLoading || !deleteFromArr ||
            cleanupEligibleCount === 0}
          onCleanupChange={setCleanupDownloads}
        />

        <PreviewStatus
          loading={preview.isLoading}
          error={preview.isError ? preview.error.message : null}
          deleteFromArr={deleteFromArr}
          coordinatedConfigured={preview.data?.coordinatedConfigured ?? false}
          arrProblems={preview.data?.coordinatedConfigured
            ? arrProblems.map((problem) => ({
              title: items.find((item) => item.ratingKey === problem.ratingKey)
                ?.title ?? problem.ratingKey,
              reason: problem.arrReason ??
                "managed deletion could not be verified",
            }))
            : []}
        />

        <DeletionTree
          items={items}
          deleteFromArr={deleteFromArr}
          arrEntries={arrEntries}
          downloadJobs={downloadJobs}
          orphanFiles={orphanFiles}
          cleanupDownloads={cleanupDownloads}
          unmanagedSources={unmanagedSources}
          retainedPaths={retainedPaths}
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
            onClick={() =>
              onConfirm({
                coordinatedRatingKeys: deleteFromArr ? coordinatedRatingKeys : [],
                cleanupDownloads: deleteFromArr && cleanupDownloads,
              })}
            disabled={pending || (deleteFromArr && preview.isLoading)}
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
    <HoverPopover content={text}>
      <button
        type="button"
        className="inline-flex cursor-help text-base-content/45 transition-colors hover:text-base-content/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        aria-label={text}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Info className="size-3.5" />
      </button>
    </HoverPopover>
  );
}

function DestinationOption({
  service,
  label,
  count,
  info,
  checked,
  disabled,
  onChange,
}: {
  service: ServiceIconName;
  label: string;
  count: number;
  info: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex min-h-9 items-center gap-2 rounded-md border px-2.5 text-sm transition-colors ${
        checked
          ? "border-primary/35 bg-primary/10 text-base-content"
          : "border-base-300 bg-base-100/35 text-base-content/65"
      } ${disabled ? "opacity-45" : "cursor-pointer hover:border-base-content/25"}`}
    >
      <ServiceIcon service={service} className="size-4 shrink-0" />
      <span className="whitespace-nowrap font-medium">{label}</span>
      <span className="text-[11px] tabular-nums text-base-content/45">
        {count}
      </span>
      <input
        type="checkbox"
        className="checkbox checkbox-sm ml-1"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <InfoTip text={info} />
    </label>
  );
}

function DestinationOptions({
  arrService,
  arrLabel,
  arrCount,
  totalCount,
  deleteFromArr,
  arrDisabled,
  onArrChange,
  cleanupDownloads,
  cleanupCount,
  cleanupInfo,
  cleanupDisabled,
  onCleanupChange,
}: {
  arrService?: "radarr" | "sonarr";
  arrLabel: string;
  arrCount: number;
  totalCount: number;
  deleteFromArr: boolean;
  arrDisabled: boolean;
  onArrChange: (checked: boolean) => void;
  cleanupDownloads: boolean;
  cleanupCount: number;
  cleanupInfo: string;
  cleanupDisabled: boolean;
  onCleanupChange: (checked: boolean) => void;
}) {
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-base-300 bg-base-200/35 p-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          Delete destinations
          <InfoTip text="Plex is always included. Optional destinations apply only to items that can be verified safely." />
        </div>
        <p className="mt-0.5 text-xs text-base-content/45">
          Plex is always included
          {deleteFromArr && arrCount < totalCount
            ? ` · ${totalCount - arrCount} ${
              totalCount - arrCount === 1 ? "item" : "items"
            } will use Plex only`
            : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <DestinationOption
          service={arrService ?? "radarr"}
          label={arrLabel}
          count={arrCount}
          info={arrCount > 0
            ? `Deletes through ${arrLabel} for ${arrCount} of ${totalCount} selected items. Items without a verified match remain Plex-only.`
            : `No selected items can currently be deleted through ${arrLabel}.`}
          checked={deleteFromArr}
          disabled={arrDisabled}
          onChange={onArrChange}
        />
        <DestinationOption
          service="qbittorrent"
          label="Downloads"
          count={cleanupCount}
          info={`${cleanupInfo} Download cleanup requires Arr deletion so managed library files are removed coherently.`}
          checked={cleanupDownloads}
          disabled={cleanupDisabled}
          onChange={onCleanupChange}
        />
      </div>
    </div>
  );
}

function ServiceMark({
  service,
  label,
  ariaLabel,
  popover,
  className,
  unavailable = false,
}: {
  service?: ServiceIconName;
  label?: string;
  ariaLabel: string;
  popover: ReactNode;
  className: string;
  unavailable?: boolean;
}) {
  return (
    <HoverPopover content={popover}>
      <span
        className={`relative inline-flex size-5 cursor-help items-center justify-center rounded p-0.5 leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${className}`}
        tabIndex={0}
        role="img"
        aria-label={ariaLabel}
      >
        {service
          ? <ServiceIcon service={service} className="size-3.5" />
          : <span className="text-[9px] font-bold">{label}</span>}
        {unavailable && (
          <span className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-error text-error-content ring-1 ring-base-200">
            <X className="size-2.5" strokeWidth={3} />
          </span>
        )}
      </span>
    </HoverPopover>
  );
}

function PlannedServiceIcons({
  deleteFromArr,
  arrService,
  arrStatus,
  arrReason,
  arrTargets,
  downloadJobCount,
  hardlinkFileCount,
  downloadCleanupResuming,
  cleanupDownloads,
  cleanupStatus,
  cleanupReason,
}: {
  deleteFromArr: boolean;
  arrService: "radarr" | "sonarr";
  arrStatus?: "resolved" | "unavailable" | "error";
  arrReason?: string;
  arrTargets: ArrCleanupTarget[];
  downloadJobCount: number;
  hardlinkFileCount: number;
  downloadCleanupResuming: boolean;
  cleanupDownloads: boolean;
  cleanupStatus?: "resolved" | "unavailable" | "error";
  cleanupReason?: string;
}) {
  const arrUnavailable = deleteFromArr && arrStatus !== undefined && arrStatus !== "resolved";
  const cleanupAvailable = downloadJobCount > 0 || hardlinkFileCount > 0 ||
    downloadCleanupResuming;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <ServiceMark
        service="plex"
        ariaLabel="Delete from Plex"
        popover={
          <>
            <div className="font-semibold">Plex</div>
            <div className="mt-1 text-base-content/55">
              This item is always removed from Plex.
            </div>
          </>
        }
        className="bg-warning/20 text-warning"
      />
      {deleteFromArr && arrUnavailable && (
        <ServiceMark
          service={arrService}
          ariaLabel={`Arr deletion unavailable: ${arrReason ?? "no verified match"}`}
          popover={
            <>
              <div className="font-semibold text-error">Arr unavailable</div>
              <div className="mt-1 text-base-content/60">
                {arrReason ?? "No verified Sonarr or Radarr match is available."}
              </div>
              <div className="mt-1 text-base-content/45">
                This item will be deleted from Plex only and may be downloaded again if it remains monitored.
              </div>
            </>
          }
          className="bg-base-300/70 text-base-content/35"
          unavailable
        />
      )}
      {deleteFromArr && arrTargets.map((target, index) => (
        <ServiceMark
          key={`${target.instanceName}:${target.type}:${index}`}
          service={target.type}
          ariaLabel={`Delete through ${target.instanceName}`}
          popover={
            <>
              <div className="font-semibold">
                {target.type === "radarr" ? "Radarr" : "Sonarr"}
              </div>
              {target.instanceName.toLocaleLowerCase() !== target.type && (
                <div className="mt-0.5 text-base-content/70">
                  {target.instanceName}
                </div>
              )}
              <div className="mt-1 text-base-content/55">
                Deletes the managed title and its files from this instance.
              </div>
            </>
          }
          className={target.type === "radarr"
            ? "bg-primary/20 text-primary"
            : "bg-info/20 text-info"}
        />
      ))}
      {cleanupDownloads && !cleanupAvailable && (
        <ServiceMark
          service="qbittorrent"
          ariaLabel={`Downloaded-file cleanup unavailable: ${cleanupReason ?? "no verified files"}`}
          popover={
            <>
              <div className="font-semibold text-error">Download cleanup unavailable</div>
              <div className="mt-1 text-base-content/60">
                {cleanupReason ??
                  (cleanupStatus === "error"
                    ? "Cleanup verification failed."
                    : "No verified download job or hardlink was found.")}
              </div>
            </>
          }
          className="bg-base-300/70 text-base-content/35"
          unavailable
        />
      )}
      {cleanupDownloads && (downloadJobCount > 0 || downloadCleanupResuming) && (
        <ServiceMark
          service="qbittorrent"
          ariaLabel={downloadJobCount > 0
            ? `Remove ${downloadJobCount} verified qBittorrent job${
              downloadJobCount === 1 ? "" : "s"
            }`
            : "Resume previously started qBittorrent cleanup"}
          popover={
            <>
              <div className="font-semibold">qBittorrent</div>
              <div className="mt-1 text-base-content/55">
                {downloadJobCount > 0
                  ? `Removes ${downloadJobCount} verified job${
                    downloadJobCount === 1 ? "" : "s"
                  } and asks qBittorrent to delete the downloaded files.`
                  : "Resumes a previously started qBittorrent cleanup before Arr deletion."}
              </div>
            </>
          }
          className="bg-secondary/20 text-secondary"
        />
      )}
      {cleanupDownloads && hardlinkFileCount > 0 && (
        <ServiceMark
          label="HL"
          ariaLabel={`Remove ${hardlinkFileCount} verified orphaned hardlink${
            hardlinkFileCount === 1 ? "" : "s"
          }`}
          popover={
            <>
              <div className="font-semibold">Verified hardlinks</div>
              <div className="mt-1 text-base-content/55">
                Unlinks {hardlinkFileCount}{" "}
                orphaned download file{hardlinkFileCount === 1 ? "" : "s"}{" "}
                after rechecking filesystem identity.
              </div>
            </>
          }
          className="bg-success/20 text-success"
        />
      )}
    </span>
  );
}

function PreviewStatus({
  loading,
  error,
  deleteFromArr,
  coordinatedConfigured,
  arrProblems,
}: {
  loading: boolean;
  error: string | null;
  deleteFromArr: boolean;
  coordinatedConfigured: boolean;
  arrProblems: Array<{ title: string; reason: string }>;
}) {
  if (!deleteFromArr) return null;
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
          No Sonarr or Radarr mapping. These items will be deleted from Plex only.
        </p>
      )}
      {!loading && !error && arrProblems.length > 0 && (
        <p className="text-warning">
          {arrProblems.length} {arrProblems.length === 1 ? "item has" : "items have"}{" "}
          no verified Arr destination and will use Plex only. Hover its crossed icon for details.
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
          className={`size-4 shrink-0 ${
            warning ? "text-warning" : "text-primary"
          }`}
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
          {[note, hiddenCount > 0 ? `${hiddenCount} more files` : null].filter(
            Boolean,
          ).join(" · ")}
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
    if (!files.has(key)) {
      files.set(key, { path: file.relativePath, size: null });
    }
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
  return job.fileCount === 1
    ? job.savePath || job.contentPath
    : job.contentPath ||
      job.savePath;
}

function downloadJobFiles(job: DownloadCleanupJob): TreeFile[] {
  const rootName = job.contentPath.split(/[\\/]+/).filter(Boolean).at(-1)
    ?.toLocaleLowerCase();
  return job.files.map((file) => {
    const segments = file.path.split(/[\\/]+/).filter(Boolean);
    const path =
      job.fileCount > 1 && segments[0]?.toLocaleLowerCase() === rootName
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
        warning
          ? "border-warning/30 bg-warning/5"
          : "border-base-300 bg-base-200/30"
      }`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 p-2.5 text-sm font-medium marker:hidden [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-base-content/40 transition-transform group-open:rotate-90" />
        <span className={warning ? "text-warning" : "text-base-content/70"}>
          {title}
        </span>
        <InfoTip text={info} />
        {count === null
          ? (
            <span className="loading loading-spinner loading-xs ml-auto text-base-content/40" />
          )
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

function DeletionTree({
  items,
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
  const hasRemaining = cleanupDownloads &&
    (unmanagedSources.length > 0 || retainedPaths.length > 0);
  const removalPathCount = deleteFromArr
    ? arrEntries.length + plexFallbackItems.length +
      (cleanupDownloads ? downloadJobs.length + orphanFiles.length : 0)
    : items.length;
  return (
    <div className="mt-3 space-y-2">
      <CollapsiblePathSection
        title="Files to be removed"
        count={loading ? null : removalPathCount}
        info="Only verified managed roots and qBittorrent payloads selected above appear here."
      >
        {plexFallbackItems.map((item) => (
          <PathTreeRoot
            key={item.ratingKey}
            path={item.title}
            source="Plex"
            note={deleteFromArr
              ? "No verified Arr destination; this item uses Plex-only deletion"
              : "Underlying media path is not available in this preview"}
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
        {deleteFromArr && cleanupDownloads &&
          downloadJobs.map((job) => (
            <PathTreeRoot
              key={`${job.instanceKey}:${job.jobId}`}
              path={downloadJobRoot(job) || job.name}
              source={job.instanceName}
              files={downloadJobFiles(job)}
              totalFiles={job.fileCount}
              info={downloadJobInfo(job)}
            />
          ))}
        {deleteFromArr && cleanupDownloads &&
          orphanFiles.map((file) => (
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
            <span className="loading loading-spinner loading-xs" />{" "}
            Loading paths…
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
