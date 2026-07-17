import type { VersionDeletionPreviewResponse } from "../../lib/api";
import { formatKilobytes } from "../../lib/format";
import { InfoTip } from "../../features/mediaDeletion/InfoTip";
import { PlannedServiceExceptions } from "../../features/mediaDeletion/DeletionPlanSummary";
import {
  ActiveServiceMark,
  downloadJobFiles,
  downloadJobInfo,
  downloadJobRoot,
  managedFiles,
  PathTreeRoot,
} from "../../features/mediaDeletion/DeletionTree";
import { versionDeletionPresentation } from "./versionDeletionState";

interface SelectedVersion {
  mediaId: number;
  label: string;
  fileSize: number | null;
}

export function VersionDeletionServiceMarks({
  preview,
  deleteFromArr,
  cleanupDownloads,
}: {
  preview?: VersionDeletionPreviewResponse;
  deleteFromArr: boolean;
  cleanupDownloads: boolean;
}) {
  const arrService = preview?.arrService ?? "radarr";
  const presentation = versionDeletionPresentation(
    preview,
    deleteFromArr,
    cleanupDownloads,
  );
  const arrActive = presentation.arrTargets.length > 0;
  const cleanupActive = presentation.downloadJobs.length > 0;
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
      {cleanupActive && (
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
        downloadJobCount={cleanupActive ? preview?.downloadJobs.length ?? 0 : 0}
        hardlinkFileCount={cleanupActive ? preview?.orphanFiles.length ?? 0 : 0}
        downloadCleanupResuming={downloadCleanupResuming}
        cleanupDownloads={cleanupDownloads}
        cleanupStatus={preview?.cleanupStatus}
        cleanupReason={preview?.cleanupReason}
      />
    </span>
  );
}

export function AdvancedVersionDeletionTree({
  title,
  versions,
  preview,
  deleteFromArr,
  cleanupDownloads,
  loading,
}: {
  title: string;
  versions: SelectedVersion[];
  preview?: VersionDeletionPreviewResponse;
  deleteFromArr: boolean;
  cleanupDownloads: boolean;
  loading: boolean;
}) {
  const previewByMediaId = new Map(
    preview?.versions.map((version) => [version.mediaId, version]) ?? [],
  );
  const presentation = versionDeletionPresentation(
    preview,
    deleteFromArr,
    cleanupDownloads,
  );
  const {
    arrTargets,
    downloadJobs,
    orphanFiles,
    showPlexPaths,
  } = presentation;
  const plexPathCount = showPlexPaths
    ? versions.reduce(
      (count, version) =>
        count + (previewByMediaId.get(version.mediaId)?.plexPaths.length ?? 0),
      0,
    )
    : 0;
  const pathCount = plexPathCount + arrTargets.length + downloadJobs.length +
    orphanFiles.length;

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
        <section className="py-1">
          <div className="flex min-w-0 items-center gap-2 text-xs leading-5">
            <span
              className="min-w-0 flex-1 truncate font-semibold"
              title={title}
            >
              {title}
            </span>
            <VersionDeletionServiceMarks
              preview={preview}
              deleteFromArr={deleteFromArr}
              cleanupDownloads={cleanupDownloads}
            />
          </div>
          <div className="ml-1.5">
            {showPlexPaths && versions.map((version) => {
              const versionPreview = previewByMediaId.get(version.mediaId);
              return (
                <div key={version.mediaId} className="py-0.5">
                  <div className="flex min-w-0 items-center gap-2 pl-3 text-[11px] leading-5 text-base-content/55">
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {version.label}
                    </span>
                    {version.fileSize !== null && (
                      <span className="shrink-0 font-mono text-[10px] text-base-content/35">
                        {formatKilobytes(version.fileSize)}
                      </span>
                    )}
                  </div>
                  {versionPreview?.plexPaths.map((path, index) => (
                    <PathTreeRoot
                      key={`plex:${version.mediaId}:${path}:${index}`}
                      path={path}
                      source="Plex"
                    />
                  ))}
                  {!loading && !versionPreview?.plexPaths.length && (
                    <p className="pl-3 text-[10px] leading-4 text-warning/80">
                      {versionPreview?.reason ??
                        "Plex returned no path for this version"}
                    </p>
                  )}
                </div>
              );
            })}
            {arrTargets.map((target) => (
              <PathTreeRoot
                key={`arr:${target.instanceName}:${target.path}`}
                path={target.path ?? target.title}
                source={target.instanceName}
                files={managedFiles(target)}
                itemName={target.type === "sonarr" ? "season" : "file"}
              />
            ))}
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
                <span className="loading loading-spinner loading-xs" />{" "}
                Loading paths…
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
