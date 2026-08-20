import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { AlertTriangle, LoaderCircle, Trash2 } from "lucide-react";
import type { StaleItem } from "../../lib/api.ts";
import { api } from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { DestinationOptions } from "../../features/mediaDeletion/DeletionPlanSummary.tsx";

export interface SeasonRemovalChoice {
  previewFingerprint: string;
  coordinated: boolean;
  cleanupDownloads: boolean;
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
    staleTime: 0,
    retry: false,
  });
  const value = preview.data;
  useEffect(() => {
    if (value?.coordinatedConfigured === false && coordinated) setCoordinated(false);
  }, [coordinated, value?.coordinatedConfigured]);
  const blocked = !value || value.blockers.length > 0 || preview.isFetching;

  return (
    <dialog ref={dialogRef} className="modal" onCancel={onCancel}>
      <div className="modal-box max-w-2xl">
        <h3 className="font-bold text-lg">Remove this season?</h3>
        <p className="mt-2 text-sm text-base-content/70">
          {item ? `${item.title} · Season ${item.seasonIndex ?? "?"}` : "Selected season"}
        </p>
        {item && (
          <div className="mt-4 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm">
            <div className="flex justify-between gap-4">
              <span>{item.leafCount ?? 0} episodes</span>
              <strong>{formatKilobytes(item.fileSize ?? 0)}</strong>
            </div>
            {preview.isFetching && (
              <div className="mt-3 flex items-center gap-2 text-base-content/60">
                <LoaderCircle className="size-4 animate-spin" />{" "}
                Verifying Plex, Sonarr, and download ownership…
              </div>
            )}
            {preview.error && (
              <div className="alert alert-error mt-3 text-sm">
                {preview.error instanceof Error ? preview.error.message : "Preview failed"}
              </div>
            )}
            {value?.blockers.map((blocker) => (
              <div key={blocker} className="alert alert-error mt-3 text-sm">
                <AlertTriangle className="size-4" /> {blocker}
              </div>
            ))}
            {value && !coordinated && (
              <div className="alert alert-warning mt-3 text-sm">
                Plex-only removal leaves Sonarr unchanged. A monitored season may be downloaded
                again.
              </div>
            )}
            {value && coordinated && value.sonarrStatus === "resolved" && (
              <p className="mt-3 text-success">
                Sonarr will keep the series, unmonitor {value.managedEpisodeCount}{" "}
                season episodes, and remove {value.managedFileCount} exact EpisodeFiles.
              </p>
            )}
            <DestinationOptions
              options={[
                {
                  id: "arr",
                  service: "sonarr",
                  label: "Update Sonarr",
                  info:
                    "Keep the series, unmonitor this season's episodes, and delete only their exact EpisodeFiles.",
                  checked: coordinated,
                  disabled: value?.coordinatedConfigured === false,
                  warning: value?.coordinatedConfigured === false,
                  onChange: setCoordinated,
                },
                {
                  id: "cleanup",
                  service: "qbittorrent",
                  label: "Clean downloads",
                  info:
                    "Remove only qBittorrent jobs whose complete payload is proven to belong to this season.",
                  checked: cleanupDownloads,
                  disabled: value?.cleanupConfigured === false,
                  warning: cleanupDownloads && value?.cleanupStatus !== "resolved",
                  onChange: setCleanupDownloads,
                },
              ]}
            />
          </div>
        )}
        {error != null && (
          <div className="alert alert-error mt-4 text-sm">
            {error instanceof Error ? error.message : "Could not start season removal"}
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
