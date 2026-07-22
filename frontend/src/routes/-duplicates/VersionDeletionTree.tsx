import type { MediaVersionPathPreview, VersionDeletionPreviewResponse } from "../../lib/api.ts";
import type { ReactNode } from "react";
import { formatKilobytes } from "../../lib/format.ts";
import { InfoTip } from "../../features/mediaDeletion/InfoTip.tsx";
import { PlannedServiceExceptions } from "../../features/mediaDeletion/DeletionPlanSummary.tsx";
import {
  ActiveServiceMark,
  downloadJobFiles,
  downloadJobInfo,
  downloadJobRoot,
  PathTreeRoot,
} from "../../features/mediaDeletion/DeletionTree.tsx";
import { versionArrDeletionActive, versionDeletionPresentation } from "./versionDeletionState.ts";

interface VersionTreeEntry {
  mediaId: number;
  label: string;
  fileSize: number | null;
  technicalInfo: ReactNode;
  selected: boolean;
}

export function VersionDeletionServiceMarks({
  preview,
  mediaId,
  path,
  deleteFromArr,
  cleanupDownloads,
}: {
  preview?: VersionDeletionPreviewResponse;
  mediaId?: number;
  path?: string;
  deleteFromArr: boolean;
  cleanupDownloads: boolean;
}) {
  const arrService = preview?.arrService ?? "radarr";
  const presentation = versionDeletionPresentation(
    preview,
    deleteFromArr,
    cleanupDownloads,
  );
  const versionPreview = mediaId === undefined
    ? undefined
    : preview?.versions.find((version) => version.mediaId === mediaId);
  const arrStatus = path === undefined
    ? versionPreview?.arrStatus ?? preview?.arrStatus
    : versionPreview?.arrPaths.includes(path)
    ? "resolved"
    : "unavailable";
  const cleanupStatus = path === undefined
    ? versionPreview?.cleanupStatus ?? preview?.cleanupStatus
    : versionPreview?.cleanupPaths.includes(path)
    ? "resolved"
    : "unavailable";
  const arrReason = versionPreview?.arrReason ?? preview?.arrReason;
  const cleanupReason = versionPreview?.cleanupReason ?? preview?.cleanupReason;
  const arrActive = versionArrDeletionActive(deleteFromArr, arrStatus);
  const cleanupResolved = cleanupDownloads && arrStatus === "resolved" &&
    cleanupStatus === "resolved";
  const qbitActive = cleanupResolved && (preview?.downloadJobs.length ?? 0) > 0;
  const hardlinkActive = cleanupResolved &&
    (preview?.orphanFiles.length ?? 0) > 0;
  const downloadCleanupResuming = Boolean(
    cleanupDownloads && preview?.cleanupStatus === "resolved" &&
      presentation.downloadJobs.length === 0 &&
      presentation.orphanFiles.length === 0,
  );
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
        arrStatus={arrStatus}
        arrReason={arrReason}
        downloadJobCount={qbitActive ? 1 : 0}
        hardlinkFileCount={hardlinkActive ? 1 : 0}
        downloadCleanupResuming={downloadCleanupResuming}
        cleanupDownloads={cleanupDownloads}
        cleanupStatus={cleanupStatus}
        cleanupReason={cleanupReason}
      />
    </span>
  );
}

export function AdvancedVersionDeletionTree({
  title,
  versions,
  preview,
  availableVersions,
  deleteFromArr,
  cleanupDownloads,
  loading,
  onToggleVersion,
}: {
  title: string;
  versions: VersionTreeEntry[];
  preview?: VersionDeletionPreviewResponse;
  availableVersions: MediaVersionPathPreview[];
  deleteFromArr: boolean;
  cleanupDownloads: boolean;
  loading: boolean;
  onToggleVersion: (mediaId: number) => void;
}) {
  const previewByMediaId = new Map(
    availableVersions.map((version) =>
      [
        version.mediaId,
        version,
      ] as const
    ),
  );
  const presentation = versionDeletionPresentation(
    preview,
    deleteFromArr,
    cleanupDownloads,
  );
  const {
    downloadJobs,
    orphanFiles,
    showPlexPaths,
  } = presentation;
  const plexPathCount = showPlexPaths
    ? versions.reduce(
      (count, version) => count + (previewByMediaId.get(version.mediaId)?.plexPaths.length ?? 0),
      0,
    )
    : 0;
  const pathCount = plexPathCount + downloadJobs.length + orphanFiles.length;

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-base-300 bg-base-200/25">
      <div className="flex h-7 items-center gap-1.5 border-b border-base-300/70 px-2.5 text-[11px] text-base-content/45">
        <span className="font-medium text-base-content/60">Deletion tree</span>
        <InfoTip text="Shows Plex paths for every version and any additional download-cleanup paths. Service icons appear only on selected deletion targets. Plex paths are informational and never authorize direct filesystem deletion." />
        {loading
          ? <span className="loading loading-spinner loading-xs ml-auto" />
          : (
            <span className="ml-auto font-mono">
              {pathCount} {pathCount === 1 ? "path" : "paths"}
            </span>
          )}
      </div>
      <div className="max-h-72 overflow-y-auto px-2.5 py-1">
        <section className="py-1">
          <div className="flex min-w-0 items-center gap-2 text-xs leading-5">
            <span
              className="min-w-0 flex-1 truncate font-semibold"
              title={title}
            >
              {title}
            </span>
          </div>
          <div className="ml-1.5">
            {showPlexPaths && versions.map((version) => {
              const versionPreview = previewByMediaId.get(version.mediaId);
              return (
                <div key={version.mediaId} className="py-0.5">
                  <label
                    className={`flex min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-0.5 pl-3 text-[11px] leading-5 transition-colors hover:bg-primary/5 focus-within:bg-primary/5 ${
                      version.selected
                        ? "bg-primary/10 text-base-content/65"
                        : "text-base-content/40"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="checkbox checkbox-xs size-4 shrink-0 rounded-[4px]"
                      checked={version.selected}
                      onChange={() => onToggleVersion(version.mediaId)}
                      aria-label={`Delete ${version.label}`}
                    />
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="min-w-0 truncate font-medium">
                        {version.label}
                      </span>
                      {version.technicalInfo}
                    </span>
                    {version.fileSize !== null && (
                      <span className="shrink-0 font-mono text-[10px] text-base-content/35">
                        {formatKilobytes(version.fileSize)}
                      </span>
                    )}
                  </label>
                  {versionPreview?.plexPaths.map((path, index) => (
                    <PathTreeRoot
                      key={`plex:${version.mediaId}:${path}:${index}`}
                      path={path}
                      marks={version.selected
                        ? (
                          <VersionDeletionServiceMarks
                            preview={preview}
                            mediaId={version.mediaId}
                            path={path}
                            deleteFromArr={deleteFromArr}
                            cleanupDownloads={cleanupDownloads}
                          />
                        )
                        : undefined}
                    />
                  ))}
                  {!loading && !versionPreview?.plexPaths.length && (
                    <p
                      className={`pl-3 text-[10px] leading-4 ${
                        version.selected ? "text-warning/80" : "text-base-content/35"
                      }`}
                    >
                      {versionPreview?.reason ??
                        "Plex returned no path for this version"}
                    </p>
                  )}
                </div>
              );
            })}
            {downloadJobs.map((job) => (
              <PathTreeRoot
                key={`job:${job.instanceKey}:${job.jobId}`}
                path={downloadJobRoot(job) || job.name}
                source={job.instanceName}
                files={downloadJobFiles(job)}
                totalFiles={job.fileCount}
                info={downloadJobInfo(job)}
              />
            ))}
            {orphanFiles.map((file) => (
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
            {loading && (
              <p className="flex items-center gap-2 py-2 pl-3 text-[11px] text-base-content/40">
                <span className="loading loading-spinner loading-xs" /> Loading paths…
              </p>
            )}
            {!loading && pathCount === 0 && (
              <p className="py-0.5 pl-3 text-[10px] text-base-content/35">
                No path details reported
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
