import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { DuplicateGroup } from "../../lib/api";
import { formatKilobytes } from "../../lib/format";
import { versionLabel } from "../../lib/mediaVersion";
import { queryKeys } from "../../lib/queryKeys";
import { DestinationOptions } from "../../features/mediaDeletion/DeletionPlanSummary";
import {
  AdvancedVersionDeletionTree,
  VersionDeletionServiceMarks,
} from "./VersionDeletionTree";
import {
  BasicDeletionList,
  BasicDeletionRow,
  DeletionDialogFooter,
  DeletionModalShell,
  DeletionPreview,
  DeletionPreviewStatus,
  PlexFallbackAcknowledgement,
  useDeletionDialogCancelFocus,
} from "../../features/mediaDeletion/DeletionDialog";
import { deletionConfirmationBlocked } from "../../features/mediaDeletion/deletionConfirmation";
import {
  defaultVersionSelection,
  versionDestinationState,
  versionSelectionSemantics,
} from "./versionDeletionState";
import "../../components/dataSurfaces.css";

export function VersionPickerDialog({
  dialogRef,
  item,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  item: DuplicateGroup | null;
  pending: boolean;
  error: unknown;
  onConfirm: (plan: {
    mediaIds: number[];
    deleteWholeItem: boolean;
    deleteFromArr: boolean;
    cleanupDownloads: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [previewMode, setPreviewMode] = useState<"basic" | "advanced">("basic");
  const [deleteFromArr, setDeleteFromArr] = useState(false);
  const [cleanupDownloads, setCleanupDownloads] = useState(false);
  const [fallbackAcknowledged, setFallbackAcknowledged] = useState(false);

  useEffect(() => {
    if (!item) return;
    setChecked(defaultVersionSelection(item.versions));
    setPreviewMode("basic");
  }, [item]);

  const mediaIds = useMemo(() => [...checked].sort((a, b) => a - b), [checked]);
  const ratingKey = item?.mediaType === "movie"
    ? item.ratingKey
    : item?.episodeRatingKey ?? "";
  const cancelButtonRef = useDeletionDialogCancelFocus(
    dialogRef,
    `${item?.mediaType ?? "none"}:${ratingKey}`,
  );
  const preview = useQuery({
    queryKey: queryKeys.versionDeletionPreview.forVersions(
      item?.mediaType,
      ratingKey,
      mediaIds,
    ),
    queryFn: () =>
      api.duplicates.versionDeletionPreview(
        item!.mediaType,
        ratingKey,
        mediaIds,
      ),
    enabled: item !== null && mediaIds.length > 0,
    retry: false,
    staleTime: 15_000,
  });

  useEffect(() => {
    setDeleteFromArr(
      versionDestinationState(preview.data).arrSelectedByDefault,
    );
    setCleanupDownloads(false);
    setFallbackAcknowledged(false);
  }, [
    item,
    mediaIds.join("|"),
    preview.data?.arrConfigured,
    preview.data?.arrStatus,
  ]);

  if (!item) {
    return <dialog ref={dialogRef} className="modal" onClose={onCancel} />;
  }

  function toggle(mediaId: number) {
    const next = new Set(checked);
    if (next.has(mediaId)) next.delete(mediaId);
    else next.add(mediaId);
    setChecked(next);
  }

  const selection = versionSelectionSemantics(
    item.mediaType,
    item.versions,
    checked,
  );
  const selectedVersions = selection.selectedVersions;
  const checkedCount = checked.size;
  const wouldDeleteAll = selection.wouldDeleteAll;
  const freedSize = selectedVersions.reduce(
    (sum, version) => sum + (version.fileSize ?? 0),
    0,
  );
  const arrLabel = item.mediaType === "movie" ? "Radarr" : "Sonarr";
  const arrService = item.mediaType === "movie" ? "radarr" : "sonarr";
  const destinations = versionDestinationState(preview.data);
  const arrAvailable = destinations.arrAvailable;
  const cleanupAvailable = destinations.cleanupAvailable;
  const arrOptionVisible = destinations.arrVisible;
  const cleanupOptionVisible = destinations.cleanupVisible;
  const cleanupUsesQbittorrent = (preview.data?.downloadJobs.length ?? 0) > 0;
  const destinationOptionsVisible = arrOptionVisible || cleanupOptionVisible;
  const fallbackRequired = preview.data?.arrConfigured === true &&
    !arrAvailable;
  const confirmDisabled = deletionConfirmationBlocked({
    pending,
    hasSelection: checkedCount > 0,
    preview: preview.isError
      ? "error"
      : preview.isLoading || !preview.data
      ? "loading"
      : "ready",
    semanticBlock: selection.blocked,
    fallbackRequired,
    fallbackAcknowledged,
  });
  return (
    <DeletionModalShell
      dialogRef={dialogRef}
      pending={pending}
      onClose={onCancel}
      title="Resolve duplicate versions"
      summary={
        <>
          {item.mediaType === "movie"
            ? item.title
            : `${item.showTitle} — S${item.seasonIndex}E${item.episodeIndex} "${item.episodeTitle}"`}
          {" "}
          has {item.versions.length}{" "}
          versions synced from Plex. Review exactly where the selected files
          will be removed.
        </>
      }
    >
      <DeletionPreview
        mode={previewMode}
        onModeChange={setPreviewMode}
        basic={
          <BasicDeletionList>
            {item.versions.map((version) => {
              const selected = checked.has(version.mediaId);
              return (
                <BasicDeletionRow
                  key={version.mediaId}
                  selection={
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={selected}
                      onChange={() => toggle(version.mediaId)}
                      aria-label={`Delete ${versionLabel(version)}`}
                    />
                  }
                  title={versionLabel(version)}
                  titleText={versionLabel(version)}
                  marks={selected
                    ? (
                      <VersionDeletionServiceMarks
                        preview={preview.data}
                        deleteFromArr={deleteFromArr}
                        cleanupDownloads={cleanupDownloads}
                      />
                    )
                    : undefined}
                  size={version.fileSize != null
                    ? formatKilobytes(version.fileSize)
                    : "—"}
                />
              );
            })}
          </BasicDeletionList>
        }
        advanced={
          <AdvancedVersionDeletionTree
            title={item.mediaType === "movie" ? item.title : item.episodeTitle}
            versions={selectedVersions.map((version) => ({
              mediaId: version.mediaId,
              label: versionLabel(version),
              fileSize: version.fileSize,
            }))}
            preview={preview.data}
            deleteFromArr={deleteFromArr}
            cleanupDownloads={cleanupDownloads}
            loading={preview.isLoading}
          />
        }
      />

      {preview.data && destinationOptionsVisible && (
        <DestinationOptions
          options={[
            ...(arrOptionVisible
              ? [{
                id: "arr" as const,
                service: arrService,
                label: arrLabel,
                info: preview.data.arrReason ??
                  `Removes only the ${arrLabel} record whose managed paths match the selected Plex versions.`,
                checked: deleteFromArr,
                disabled: pending || !arrAvailable,
                warning: !arrAvailable,
                onChange: (checked: boolean) => {
                  setDeleteFromArr(checked);
                  setFallbackAcknowledged(false);
                  if (!checked) setCleanupDownloads(false);
                },
              }]
              : []),
            ...(cleanupOptionVisible
              ? [{
                id: "cleanup" as const,
                service: cleanupUsesQbittorrent
                  ? "qbittorrent" as const
                  : undefined,
                label: cleanupUsesQbittorrent
                  ? "qBittorrent"
                  : "Downloaded files",
                info: preview.data.cleanupReason ??
                  "Deletes only a qBittorrent payload tied exclusively to the selected version paths.",
                checked: cleanupDownloads,
                disabled: pending || !deleteFromArr || !cleanupAvailable,
                warning: !cleanupAvailable,
                onChange: setCleanupDownloads,
              }]
              : []),
          ]}
        />
      )}

      <DeletionPreviewStatus
        loading={preview.isLoading}
        error={preview.isError ? preview.error.message : null}
      />
      {fallbackRequired && (
        <PlexFallbackAcknowledgement
          checked={fallbackAcknowledged}
          pending={pending}
          onChange={setFallbackAcknowledged}
        >
          Delete from Plex only. {preview.data?.arrReason}{" "}
          The version may be downloaded again if it remains monitored.
        </PlexFallbackAcknowledgement>
      )}
      {wouldDeleteAll && (
        <p className="mt-2 text-sm text-warning">
          {item.mediaType === "movie"
            ? `This selection removes “${item.title}” entirely.`
            : "At least one version must be kept — uncheck one to continue."}
        </p>
      )}
      {error != null && (
        <p className="mt-2 text-sm text-error">
          {error instanceof Error ? error.message : "Delete failed"}
        </p>
      )}

      <DeletionDialogFooter
        cancelButtonRef={cancelButtonRef}
        pending={pending}
        confirmDisabled={confirmDisabled}
        confirmLabel={
          <>
            Delete {checkedCount} version{checkedCount === 1 ? "" : "s"}{" "}
            ({formatKilobytes(freedSize)})
          </>
        }
        onCancel={onCancel}
        onConfirm={() =>
          onConfirm({
            mediaIds,
            deleteWholeItem: selection.deleteWholeItem,
            deleteFromArr: deleteFromArr && arrAvailable,
            cleanupDownloads: deleteFromArr && arrAvailable &&
              cleanupDownloads,
          })}
      />
    </DeletionModalShell>
  );
}
