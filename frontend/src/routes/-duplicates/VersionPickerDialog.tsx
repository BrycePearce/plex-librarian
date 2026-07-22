import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "../../lib/api";
import type { DuplicateGroup, MediaVersionPathPreview } from "../../lib/api";
import { formatKilobytes } from "../../lib/format";
import { needsTechnicalDetailRefresh, versionLabel } from "../../lib/mediaVersion";
import { VersionTechnicalInfo } from "./VersionTechnicalInfo";
import { compareDuplicateVersions } from "@shared/mediaComparison";
import { comparisonIcon, comparisonToneClass } from "./duplicatePresentation";
import { queryKeys } from "../../lib/queryKeys";
import { DestinationOptions } from "../../features/mediaDeletion/DeletionPlanSummary";
import { AdvancedVersionDeletionTree, VersionDeletionServiceMarks } from "./VersionDeletionTree";
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
  versionPlexFallbackRequired,
  versionSelectionSemantics,
} from "./versionDeletionState";
import "../../components/dataSurfaces.css";

function useDelayedFlag(
  active: boolean,
  delayMs: number,
  minimumVisibleMs = 300,
): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (active && !visible) {
      const timeout = setTimeout(() => {
        shownAt.current = performance.now();
        setVisible(true);
      }, delayMs);
      return () => clearTimeout(timeout);
    }
    if (active || !visible) {
      return;
    }
    const elapsed = performance.now() - (shownAt.current ?? 0);
    const timeout = setTimeout(() => {
      shownAt.current = null;
      setVisible(false);
    }, Math.max(0, minimumVisibleMs - elapsed));
    return () => clearTimeout(timeout);
  }, [active, delayMs, minimumVisibleMs, visible]);

  return visible;
}

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
    arrMediaIds: number[];
    cleanupMediaIds: number[];
  }) => void;
  onCancel: () => void;
}) {
  const itemKey = item
    ? `${item.mediaType}:${item.mediaType === "movie" ? item.ratingKey : item.episodeRatingKey}`
    : "none";
  const defaultChecked = useMemo(
    () => item ? defaultVersionSelection(item.versions) : new Set<number>(),
    [itemKey],
  );
  const [selectionState, setSelectionState] = useState<{
    itemKey: string;
    checked: Set<number>;
  }>(() => ({
    itemKey,
    checked: defaultChecked,
  }));
  const checked = selectionState.itemKey === itemKey ? selectionState.checked : defaultChecked;
  const [previewModeState, setPreviewModeState] = useState<{
    itemKey: string;
    mode: "basic" | "advanced";
  }>({ itemKey, mode: "basic" });
  const previewMode = previewModeState.itemKey === itemKey ? previewModeState.mode : "basic";
  const [deleteFromArr, setDeleteFromArr] = useState(false);
  const [cleanupDownloads, setCleanupDownloads] = useState(false);
  const [fallbackAcknowledged, setFallbackAcknowledged] = useState(false);
  const queryClient = useQueryClient();

  useLayoutEffect(() => {
    if (item && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [dialogRef, item]);

  useEffect(() => {
    setSelectionState({ itemKey, checked: defaultChecked });
    setPreviewModeState({ itemKey, mode: "basic" });
  }, [defaultChecked, itemKey]);

  const mediaIds = useMemo(() => [...checked].sort((a, b) => a - b), [checked]);
  const ratingKey = item?.mediaType === "movie" ? item.ratingKey : item?.episodeRatingKey ?? "";
  const cancelButtonRef = useDeletionDialogCancelFocus(
    dialogRef,
    `${item?.mediaType ?? "none"}:${ratingKey}`,
  );
  // The sync-time bulk listing can omit Part.Stream detail even when the single-item
  // endpoint has it. Enrich any group with an incomplete version: a known video or
  // bitrate difference can classify the group before audio/subtitle tracks are loaded.
  const needsTechnicalRefresh = item !== null &&
    needsTechnicalDetailRefresh(item.versions);
  const technicalRefresh = useQuery({
    queryKey: queryKeys.duplicates.technicalRefresh(
      item?.mediaType ?? "movie",
      ratingKey,
    ),
    queryFn: () => api.duplicates.refreshTechnicalDetails(item!.mediaType, ratingKey),
    enabled: needsTechnicalRefresh,
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (!technicalRefresh.data) return;
    // Refresh the list projection without invalidating this active refresh query and
    // creating a request loop.
    void queryClient.invalidateQueries({ queryKey: queryKeys.duplicates.lists });
  }, [technicalRefresh.data, queryClient]);
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
  const showPreviewLoading = useDelayedFlag(preview.isLoading, 250);
  const [pathContext, setPathContext] = useState<
    {
      itemKey: string;
      versions: MediaVersionPathPreview[];
    } | null
  >(null);

  useEffect(() => {
    if (!preview.data?.availableVersions) return;
    setPathContext({ itemKey, versions: preview.data.availableVersions });
  }, [itemKey, preview.data?.availableVersions]);

  const availableVersionPaths = preview.data?.availableVersions ??
    (pathContext?.itemKey === itemKey ? pathContext.versions : undefined) ??
    preview.data?.versions ?? [];

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
    setSelectionState({ itemKey, checked: next });
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
  const arrService = item.mediaType === "movie" ? "radarr" as const : "sonarr" as const;
  const destinations = versionDestinationState(preview.data);
  const arrAvailable = destinations.arrAvailable;
  const arrDeleteAvailable = destinations.arrDeleteAvailable;
  const cleanupAvailable = destinations.cleanupAvailable;
  const arrOptionVisible = destinations.arrVisible;
  const cleanupOptionVisible = destinations.cleanupVisible;
  const cleanupUsesQbittorrent = (preview.data?.downloadJobs.length ?? 0) > 0;
  const destinationOptionsVisible = arrOptionVisible || cleanupOptionVisible;
  // Merge in refreshed technical detail by mediaId where available — selection state,
  // fileSize, and everything else stays keyed off item.versions; only the fields the
  // refresh can improve (video/audio/subtitle technical detail) are swapped in.
  const refreshedByMediaId = new Map(
    technicalRefresh.data?.versions.map((
      version,
    ) => [version.mediaId, version]) ?? [],
  );
  const displayVersions = item.versions.map((version) =>
    refreshedByMediaId.get(version.mediaId) ?? version
  );
  const comparison = compareDuplicateVersions(displayVersions);
  const ComparisonIcon = comparisonIcon(comparison.kind);
  const fallbackRequired = versionPlexFallbackRequired(preview.data);
  const confirmDisabled = deletionConfirmationBlocked({
    pending,
    hasSelection: checkedCount > 0,
    preview: preview.isError ? "error" : preview.isLoading || !preview.data ? "loading" : "ready",
    semanticBlock: selection.blocked,
    fallbackRequired,
    fallbackAcknowledged,
  });
  const arrMediaIds = deleteFromArr && arrDeleteAvailable
    ? preview.data?.versions.filter((version) =>
      mediaIds.includes(version.mediaId) && version.arrStatus === "resolved"
    ).map((version) => version.mediaId) ?? []
    : [];
  const cleanupMediaIds = cleanupDownloads && arrDeleteAvailable
    ? preview.data?.versions.filter((version) =>
      mediaIds.includes(version.mediaId) && version.arrStatus === "resolved" &&
      version.cleanupStatus === "resolved"
    ).map((version) => version.mediaId) ?? []
    : [];
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
          versions synced from Plex. Review exactly where the selected files will be removed.
        </>
      }
    >
      <div
        className={`alert items-start gap-2.5 py-2 text-sm duplicates-review-comparison duplicates-review-comparison-${comparison.kind}`}
      >
        <ComparisonIcon
          className={`mt-0.5 size-4 shrink-0 ${comparisonToneClass(comparison.kind)}`}
        />
        <div className="min-w-0">
          <div className="font-semibold">{comparison.label}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {comparison.reasons.map((reason) => (
              <span key={reason} className="duplicates-quality-chip">
                {reason}
              </span>
            ))}
          </div>
          {comparison.kind === "same-profile" && (
            <div className="mt-1.5 text-xs opacity-70">
              This compares Plex metadata; it does not prove the files are byte-identical.
            </div>
          )}
          {technicalRefresh.isFetching && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs opacity-70">
              <Loader2 className="size-3 animate-spin" />
              Checking Plex for more detail…
            </div>
          )}
        </div>
      </div>
      <DeletionPreview
        mode={previewMode}
        onModeChange={(mode) => setPreviewModeState({ itemKey, mode })}
        basic={
          <BasicDeletionList>
            {displayVersions.map((version) => {
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
                  selected={selected}
                  title={versionLabel(version)}
                  titleText={versionLabel(version)}
                  badges={<VersionTechnicalInfo version={version} />}
                  marks={selected
                    ? (
                      <VersionDeletionServiceMarks
                        preview={preview.data}
                        mediaId={version.mediaId}
                        deleteFromArr={deleteFromArr}
                        cleanupDownloads={cleanupDownloads}
                      />
                    )
                    : undefined}
                  size={version.fileSize != null ? formatKilobytes(version.fileSize) : "—"}
                />
              );
            })}
          </BasicDeletionList>
        }
        advanced={
          <AdvancedVersionDeletionTree
            title={item.mediaType === "movie" ? item.title : item.episodeTitle}
            versions={item.versions.map((version) => {
              const displayVersion = refreshedByMediaId.get(version.mediaId) ??
                version;
              return {
                mediaId: version.mediaId,
                label: versionLabel(displayVersion),
                fileSize: version.fileSize,
                technicalInfo: <VersionTechnicalInfo version={displayVersion} />,
                selected: checked.has(version.mediaId),
              };
            })}
            preview={preview.data}
            availableVersions={availableVersionPaths}
            deleteFromArr={deleteFromArr}
            cleanupDownloads={cleanupDownloads}
            loading={preview.isLoading}
            onToggleVersion={toggle}
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
                info:
                  `Removes only the ${arrLabel} record whose managed paths match the selected Plex versions.`,
                checked: deleteFromArr,
                disabled: pending,
                warning: false,
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
                service: cleanupUsesQbittorrent ? "qbittorrent" as const : undefined,
                label: cleanupUsesQbittorrent ? "qBittorrent" : "Downloaded files",
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
        loading={showPreviewLoading}
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
            arrMediaIds,
            cleanupMediaIds,
          })}
      />
    </DeletionModalShell>
  );
}
