import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { AlertTriangle, HardDrive, ListVideo, LoaderCircle, Trash2 } from "lucide-react";
import type { StaleItem } from "../../lib/api.ts";
import { api } from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { DestinationOptions } from "../../features/mediaDeletion/DeletionPlanSummary.tsx";
import {
  ActiveServiceMark,
  downloadJobFiles,
  downloadJobInfo,
  downloadJobRoot,
  PathTreeRoot,
} from "../../features/mediaDeletion/DeletionTree.tsx";
import { InfoTip } from "../../features/mediaDeletion/InfoTip.tsx";
import type { SeasonRemovalPreviewResponse } from "@shared/types";

export interface SeasonRemovalChoice {
  previewFingerprint: string;
  coordinated: boolean;
  cleanupDownloads: boolean;
}

export function seasonCleanupAvailable(
  preview: Pick<SeasonRemovalPreviewResponse, "downloadJobs"> | undefined,
): boolean {
  return (preview?.downloadJobs.length ?? 0) > 0;
}

export function seasonSonarrActionAvailable(
  preview: Pick<SeasonRemovalPreviewResponse, "sonarrActionAvailable"> | undefined,
): boolean {
  return preview?.sonarrActionAvailable === true;
}

export function usableSeasonRemovalPreview<T>(data: T | undefined, error: unknown): T | undefined {
  return error == null ? data : undefined;
}

interface PreviewFile {
  source: string;
  service: "plex" | "sonarr";
  path: string;
  size: number;
}

function groupedPreviewFiles(files: PreviewFile[]) {
  const groups = new Map<
    string,
    {
      source: string;
      service: "plex" | "sonarr";
      root: string;
      files: Array<{ path: string; size: number }>;
    }
  >();
  for (const file of files) {
    const separator = Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\"));
    const root = separator > 0 ? file.path.slice(0, separator) : file.path;
    const name = separator > 0 ? file.path.slice(separator + 1) : file.path;
    const key = `${file.service}\0${file.source}\0${root}`;
    const group = groups.get(key) ?? {
      source: file.source,
      service: file.service,
      root,
      files: [],
    };
    group.files.push({ path: name, size: file.size });
    groups.set(key, group);
  }
  return [...groups.values()];
}

function SeasonRemovalDeletionTree({
  preview,
  coordinated,
  cleanupDownloads,
  loading,
}: {
  preview: SeasonRemovalPreviewResponse | undefined;
  coordinated: boolean;
  cleanupDownloads: boolean;
  loading: boolean;
}) {
  const fileGroups = groupedPreviewFiles([
    ...(preview?.plexFiles.map((file) => ({
      ...file,
      source: "Plex",
      service: "plex" as const,
    })) ?? []),
    ...(coordinated
      ? preview?.sonarrFiles.map((file) => ({
        path: file.path,
        size: file.size,
        source: file.instanceName,
        service: "sonarr" as const,
      })) ?? []
      : []),
  ]);
  const downloadJobs = cleanupDownloads ? preview?.downloadJobs ?? [] : [];
  const pathCount = (preview?.plexFiles.length ?? 0) +
    (coordinated ? preview?.sonarrFiles.length ?? 0 : 0) +
    downloadJobs.reduce((total, job) => total + job.fileCount, 0);

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-base-300 bg-base-100/40">
      <div className="flex h-7 items-center gap-1.5 border-b border-base-300/70 px-2.5 text-[11px] text-base-content/45">
        <span className="font-medium text-base-content/60">Deletion preview</span>
        <InfoTip text="Shows every file path reported by Plex and each selected cleanup service. The services revalidate these exact targets before deletion." />
        {loading
          ? <span className="loading loading-spinner loading-xs ml-auto" />
          : (
            <span className="ml-auto font-mono">
              {pathCount} {pathCount === 1 ? "path" : "paths"}
            </span>
          )}
      </div>
      <div className="max-h-64 overflow-y-auto px-2.5 py-1">
        {fileGroups.map((group) => (
          <PathTreeRoot
            key={`${group.source}:${group.root}`}
            path={group.root}
            source={group.source}
            marks={
              <ActiveServiceMark
                service={group.service}
                label={group.service === "plex" ? "Plex deletion" : "Sonarr update"}
              />
            }
            files={group.files}
            totalFiles={group.files.length}
          />
        ))}
        {downloadJobs.map((job) => (
          <PathTreeRoot
            key={`job:${job.instanceKey}:${job.jobId}`}
            path={downloadJobRoot(job) || job.name}
            source={job.instanceName}
            marks={
              <ActiveServiceMark
                service="qbittorrent"
                label="qBittorrent download cleanup"
              />
            }
            files={downloadJobFiles(job)}
            totalFiles={job.fileCount}
            info={downloadJobInfo(job)}
          />
        ))}
        {loading && (
          <p className="flex items-center gap-2 py-2 text-[11px] text-base-content/40">
            <span className="loading loading-spinner loading-xs" /> Loading files…
          </p>
        )}
        {!loading && pathCount === 0 && (
          <p className="py-1 text-[10px] text-base-content/35">No file paths reported</p>
        )}
      </div>
    </div>
  );
}

export function SeasonRemovalDialog({
  dialogRef,
  libraryKey,
  item,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  libraryKey: string;
  item: StaleItem | null;
  pending: boolean;
  error: unknown;
  onConfirm: (choice: SeasonRemovalChoice) => void;
  onCancel: () => void;
}) {
  const [coordinated, setCoordinated] = useState(true);
  const [cleanupDownloads, setCleanupDownloads] = useState(false);
  useEffect(() => {
    setCoordinated(true);
    setCleanupDownloads(false);
  }, [item?.ratingKey]);
  const preview = useQuery({
    queryKey: [
      "stale-season-removal-preview",
      libraryKey,
      item?.ratingKey,
      coordinated,
      cleanupDownloads,
    ],
    queryFn: () =>
      api.libraries.seasonRemovalPreview(libraryKey, item!.ratingKey, {
        coordinated,
        cleanupDownloads,
      }),
    enabled: item !== null,
    placeholderData: (previous) =>
      previous?.seasonRatingKey === item?.ratingKey ? previous : undefined,
    staleTime: 0,
    retry: false,
  });
  // A failed refetch can retain placeholder data from the previous destination choice.
  // Never present or submit that stale plan alongside the new verification error.
  const value = usableSeasonRemovalPreview(preview.data, preview.error);
  const sonarrActionAvailable = seasonSonarrActionAvailable(value);
  useEffect(() => {
    if (value && !sonarrActionAvailable && coordinated) setCoordinated(false);
  }, [coordinated, sonarrActionAvailable, value]);
  const cleanupAvailable = seasonCleanupAvailable(value);
  useEffect(() => {
    if (value && !cleanupAvailable && cleanupDownloads) setCleanupDownloads(false);
  }, [cleanupAvailable, cleanupDownloads, value]);
  const blocked = !value || value.blockers.length > 0 || preview.isFetching ||
    (coordinated && !sonarrActionAvailable);

  return (
    <dialog ref={dialogRef} className="modal" onCancel={onCancel}>
      <div className="modal-box max-w-3xl">
        <h3 className="font-bold text-lg">Remove this season?</h3>
        <p className="mt-2 text-sm text-base-content/70">
          {item ? `${item.title} · Season ${item.seasonIndex ?? "?"}` : "Selected season"}
        </p>
        {preview.error && (
          <div className="alert alert-error mt-4 items-start text-sm" role="alert">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">Couldn’t verify this removal</div>
              <p className="mt-1 text-error-content/80">
                {preview.error instanceof Error
                  ? preview.error.message
                  : "The deletion preview could not be verified. Try again in a moment."}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm shrink-0"
              disabled={preview.isFetching}
              onClick={() => void preview.refetch()}
            >
              {preview.isFetching && <LoaderCircle className="size-4 animate-spin" />}
              Try again
            </button>
          </div>
        )}
        {error != null && (
          <div className="alert alert-error mt-4 items-start text-sm" role="alert">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="font-semibold">Couldn’t start the removal</div>
              <p className="mt-1 text-error-content/80">
                {error instanceof Error ? error.message : "Could not start season removal"}
              </p>
            </div>
          </div>
        )}
        {item && (
          <div className="mt-4 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm">
            <div className="flex items-center justify-between gap-4 text-base-content/70">
              <span className="inline-flex items-center gap-2">
                <span className="inline-flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <ListVideo className="size-4" />
                </span>
                <span>
                  <strong className="font-semibold text-base-content">
                    {item.leafCount ?? 0}
                  </strong>{" "}
                  episodes
                </span>
              </span>
              <span className="inline-flex items-center gap-2">
                <HardDrive className="size-4 text-base-content/40" />
                <strong className="font-semibold text-base-content">
                  {formatKilobytes(item.fileSize ?? 0)}
                </strong>
              </span>
            </div>
            {preview.isFetching && (
              <div className="mt-3 flex items-center gap-2 text-base-content/60">
                <LoaderCircle className="size-4 animate-spin" />{" "}
                Verifying Plex, Sonarr, and download ownership…
              </div>
            )}
            {value?.blockers.map((blocker) => (
              <div key={blocker} className="alert alert-error mt-3 text-sm">
                <AlertTriangle className="size-4" /> {blocker}
              </div>
            ))}
            {value && coordinated && value.sonarrStatus === "resolved" && (
              <p className="mt-3 text-success">
                Sonarr will keep the series, unmonitor {value.monitoredEpisodeCount}{" "}
                season episodes, and remove {value.managedFileCount} exact EpisodeFiles.
              </p>
            )}
            {!preview.error && (
              <>
                <DestinationOptions
                  options={[
                    ...(sonarrActionAvailable
                      ? [{
                        id: "arr" as const,
                        service: "sonarr" as const,
                        label: "Update Sonarr",
                        info:
                          "Keep the series, unmonitor this season's monitored episodes, and delete only their exact EpisodeFiles.",
                        checked: coordinated,
                        disabled: value?.sonarrStatus !== "resolved",
                        warning: coordinated && value?.sonarrStatus !== "resolved",
                        onChange: setCoordinated,
                      }]
                      : []),
                    ...(cleanupAvailable
                      ? [{
                        id: "cleanup" as const,
                        service: "qbittorrent" as const,
                        label: "Clean downloads",
                        info:
                          "Remove only qBittorrent jobs whose complete payload is proven to belong to this season.",
                        checked: cleanupDownloads,
                        disabled: value?.cleanupStatus !== "resolved",
                        warning: cleanupDownloads && value?.cleanupStatus !== "resolved",
                        onChange: setCleanupDownloads,
                      }]
                      : []),
                  ]}
                />
                <SeasonRemovalDeletionTree
                  preview={value}
                  coordinated={coordinated}
                  cleanupDownloads={cleanupDownloads}
                  loading={preview.isFetching}
                />
              </>
            )}
          </div>
        )}
        <div className="modal-action">
          <button type="button" className="btn" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-error gap-2"
            disabled={pending || blocked}
            onClick={() =>
              value && onConfirm({
                previewFingerprint: value.fingerprint,
                coordinated,
                cleanupDownloads,
              })}
          >
            {pending
              ? <LoaderCircle className="size-4 animate-spin" />
              : <Trash2 className="size-4" />}
            Remove season
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="button" disabled={pending} onClick={onCancel}>close</button>
      </form>
    </dialog>
  );
}
