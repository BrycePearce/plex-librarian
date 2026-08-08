import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleHelp, Loader2 } from "lucide-react";
import { api, deletionOperationIdFromError } from "../../lib/api.ts";
import type { DuplicateGroup, MediaVersionPathPreview } from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { needsTechnicalDetailRefresh, versionLabel } from "../../lib/mediaVersion.ts";
import { VersionTechnicalInfo } from "../../features/mediaDeletion/VersionTechnicalInfo.tsx";
import { compareDuplicateVersions } from "@shared/mediaComparison";
import { comparisonIcon, comparisonToneClass } from "./duplicatePresentation.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { DestinationOptions } from "../../features/mediaDeletion/DeletionPlanSummary.tsx";
import {
  AdvancedVersionDeletionTree,
  VersionDeletionServiceMarks,
} from "./VersionDeletionTree.tsx";
import {
  BasicDeletionList,
  BasicDeletionRow,
  DeletionDialogFooter,
  DeletionModalShell,
  DeletionPreview,
  DeletionPreviewStatus,
  useDelayedFlag,
  useDeletionDialogCancelFocus,
} from "../../features/mediaDeletion/DeletionDialog.tsx";
import { deletionConfirmationBlocked } from "../../features/mediaDeletion/deletionConfirmation.ts";
import {
  defaultVersionSelection,
  radarrRemovalConsentState,
  versionArrDestinationCopy,
  versionDestinationOptionVisibility,
  versionDestinationState,
  versionPlexFallbackWarning,
  versionSelectionSemantics,
} from "./versionDeletionState.ts";
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
    cleanupMediaIds: number[];
    planFingerprint?: string;
    allowRadarrMovieRemoval?: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const itemKey = item
    ? `${item.mediaType}:${item.mediaType === "movie" ? item.ratingKey : item.episodeRatingKey}`
    : "none";
  const defaultChecked = useMemo(
    () => (item ? defaultVersionSelection(item.versions) : new Set<number>()),
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
  const [allowRadarrMovieRemoval, setAllowRadarrMovieRemoval] = useState(false);
  const queryClient = useQueryClient();

  useLayoutEffect(() => {
    if (item && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [dialogRef, item]);

  useEffect(() => {
    setSelectionState({ itemKey, checked: defaultChecked });
    setPreviewModeState({ itemKey, mode: "basic" });
    setAllowRadarrMovieRemoval(false);
  }, [defaultChecked, itemKey]);

  const mediaIds = useMemo(() => [...checked].sort((a, b) => a - b), [checked]);
  const ratingKey = item?.mediaType === "movie" ? item.ratingKey : (item?.episodeRatingKey ?? "");
  const cancelButtonRef = useDeletionDialogCancelFocus(
    dialogRef,
    `${item?.mediaType ?? "none"}:${ratingKey}`,
  );
  // The sync-time bulk listing can omit Part.Stream detail even when the single-item
  // endpoint has it. Enrich any group with an incomplete version: a known video or
  // bitrate difference can classify the group before audio/subtitle tracks are loaded.
  const needsTechnicalRefresh = item !== null && needsTechnicalDetailRefresh(item.versions);
  const technicalRefresh = useQuery({
    queryKey: queryKeys.duplicates.technicalRefresh(item?.mediaType ?? "movie", ratingKey),
    queryFn: () => api.duplicates.refreshTechnicalDetails(item!.mediaType, ratingKey),
    enabled: needsTechnicalRefresh,
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (!technicalRefresh.data) return;
    // Refresh the list projection without invalidating this active refresh query and
    // creating a request loop.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.duplicates.lists,
    });
  }, [technicalRefresh.data, queryClient]);
  const preview = useQuery({
    queryKey: queryKeys.versionDeletionPreview.forVersions(
      item?.mediaType,
      ratingKey,
      mediaIds,
      cleanupDownloads,
    ),
    queryFn: () =>
      api.duplicates.versionDeletionPreview(item!.mediaType, ratingKey, mediaIds, cleanupDownloads),
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
    preview.data?.versions ??
    [];

  useEffect(() => {
    const destination = versionDestinationState(preview.data);
    setDeleteFromArr(destination.arrSelectedByDefault);
    setCleanupDownloads(false);
  }, [
    item,
    mediaIds.join("|"),
    preview.data?.arrConfigured,
    preview.data?.arrStatus,
    preview.data?.arrReassignStatus,
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

  const selection = versionSelectionSemantics(item.mediaType, item.versions, checked);
  const selectedVersions = selection.selectedVersions;
  const checkedCount = checked.size;
  const wouldDeleteAll = selection.wouldDeleteAll;
  const freedSize = selectedVersions.reduce((sum, version) => sum + (version.fileSize ?? 0), 0);
  const arrLabel = item.mediaType === "movie" ? "Radarr" : "Sonarr";
  const arrService = item.mediaType === "movie" ? ("radarr" as const) : ("sonarr" as const);
  const destinations = versionDestinationState(preview.data);
  const arrAvailable = destinations.arrAvailable;
  const arrDeleteAvailable = destinations.arrDeleteAvailable;
  const arrReassignAvailable = destinations.arrReassignAvailable;
  const cleanupAvailable = destinations.cleanupAvailable;
  const cleanupUsesQbittorrent = (preview.data?.downloadJobs.length ?? 0) > 0;
  const pathAdoption = preview.data?.radarrPathAdoption;
  const pathConsent = radarrRemovalConsentState(preview.data, allowRadarrMovieRemoval);
  const pathConsentRequired = pathConsent.visible;
  const destinationOptionVisibility = versionDestinationOptionVisibility(preview.data);
  const destinationOptionsVisible = destinationOptionVisibility.arr ||
    destinationOptionVisibility.cleanup;
  // Merge in refreshed technical detail by mediaId where available — selection state,
  // fileSize, and everything else stays keyed off item.versions; only the fields the
  // refresh can improve (video/audio/subtitle technical detail) are swapped in.
  const refreshedByMediaId = new Map(
    technicalRefresh.data?.versions.map((version) => [version.mediaId, version]) ?? [],
  );
  const displayVersions = item.versions.map(
    (version) => refreshedByMediaId.get(version.mediaId) ?? version,
  );
  const comparison = compareDuplicateVersions(displayVersions);
  const ComparisonIcon = comparisonIcon(comparison.kind);
  const showFallbackWarning = versionPlexFallbackWarning(preview.data);
  // Arr reassignment is a backend-enforced safety step when the selected file is the
  // managed copy. Keep the UI checked even during the render before the preview-driven
  // state effect catches up.
  const effectiveDeleteFromArr = arrReassignAvailable || deleteFromArr;
  const reassignActive = preview.data?.arrReassignStatus === "resolved";
  const arrDestinationCopy = versionArrDestinationCopy(
    preview.data,
    arrLabel,
    arrReassignAvailable,
  );
  const cleanupMediaIds = cleanupDownloads && arrDeleteAvailable && !reassignActive
    ? (preview.data?.versions
      .filter(
        (version) =>
          mediaIds.includes(version.mediaId) &&
          version.arrStatus === "resolved" &&
          version.cleanupStatus === "resolved",
      )
      .map((version) => version.mediaId) ?? [])
    : [];
  const confirmDisabled = deletionConfirmationBlocked({
    pending,
    hasSelection: checkedCount > 0,
    preview: preview.isError ? "error" : preview.isLoading || !preview.data ? "loading" : "ready",
    semanticBlock: selection.blocked,
  }) ||
    pathConsent.blocked ||
    (cleanupDownloads && !cleanupAvailable);
  const blockingOperationId = deletionOperationIdFromError(preview.error) ??
    deletionOperationIdFromError(error);
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
                        deleteFromArr={effectiveDeleteFromArr}
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
              const displayVersion = refreshedByMediaId.get(version.mediaId) ?? version;
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
            deleteFromArr={effectiveDeleteFromArr}
            cleanupDownloads={cleanupDownloads}
            loading={preview.isLoading}
            onToggleVersion={toggle}
          />
        }
      />

      {preview.data && destinationOptionsVisible && (
        <DestinationOptions
          options={[
            ...(destinationOptionVisibility.arr
              ? [
                {
                  id: "arr" as const,
                  service: arrService,
                  label: arrDestinationCopy.label,
                  info: arrDestinationCopy.info,
                  checked: effectiveDeleteFromArr,
                  disabled: pending || arrReassignAvailable,
                  warning: false,
                  onChange: (checked: boolean) => {
                    setDeleteFromArr(checked);
                    if (!checked) setCleanupDownloads(false);
                  },
                },
              ]
              : []),
            ...(destinationOptionVisibility.cleanup
              ? [
                {
                  id: "cleanup" as const,
                  service: cleanupUsesQbittorrent ? ("qbittorrent" as const) : undefined,
                  label: cleanupUsesQbittorrent ? "qBittorrent" : "Downloaded files",
                  info: reassignActive
                    ? `Unavailable while ${arrLabel} is reassigning its record to the retained version.`
                    : !cleanupDownloads
                    ? "Select to inspect configured download clients for an independently authorized cleanup."
                    : (preview.data.cleanupReason ??
                      "Deletes only a qBittorrent payload tied exclusively to the selected version paths."),
                  checked: cleanupDownloads,
                  disabled: pending || !deleteFromArr || reassignActive,
                  warning: (cleanupDownloads && !cleanupAvailable) || reassignActive,
                  onChange: setCleanupDownloads,
                },
              ]
              : []),
          ]}
        />
      )}

      {pathAdoption && pathAdoption.mode === "adopt_safe_path" && (
        <div className="alert alert-warning mt-2 items-start text-sm">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Radarr will adopt the retained folder</div>
            <div className="mt-1 break-all text-xs">
              <div>Current movie path: {pathAdoption.originalPath}</div>
              <div>New movie path: {pathAdoption.proposedMoviePath}</div>
              <div>Retained Plex file: {pathAdoption.retainedPath}</div>
            </div>
            <p className="mt-1 text-xs opacity-80">
              Plex Librarian updates only Radarr's movie path with moveFiles=false, then asks Radarr
              to rescan. Radarr may later rename, upgrade, or delete files it manages in that
              folder.
            </p>
          </div>
        </div>
      )}

      {pathAdoption?.mode === "remove_from_radarr" && (
        <div className="alert alert-warning mt-2 items-start text-sm">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Radarr will stop managing this movie</div>
            <p className="mt-1 text-xs">
              Radarr cannot safely adopt the retained Plex copy. Plex Librarian will add an import
              exclusion, remove the Radarr record without deleting files, then delete only the
              selected Plex version.
            </p>
            <div className="mt-1 break-all text-xs">
              <div>Selected Plex file: {pathAdoption.selectedPlexPath}</div>
              <div>Retained Plex file: {pathAdoption.retainedPlexPath}</div>
            </div>
            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="checkbox checkbox-sm mt-0.5"
                checked={allowRadarrMovieRemoval}
                disabled={pending}
                onChange={(event) => setAllowRadarrMovieRemoval(event.currentTarget.checked)}
              />
              <span className="font-medium">
                Remove this movie from Radarr without deleting its files
              </span>
              <span
                title="The retained copy stays in Plex but will no longer receive Radarr upgrades."
                aria-label="About Radarr movie removal"
              >
                <CircleHelp className="mt-0.5 size-4 shrink-0" />
              </span>
            </label>
            {!allowRadarrMovieRemoval && (
              <p className="mt-2 text-xs">
                To keep Radarr unchanged, delete the other Plex version instead.
              </p>
            )}
          </div>
        </div>
      )}

      <DeletionPreviewStatus
        error={preview.isError && blockingOperationId === null ? preview.error.message : null}
        onRetry={blockingOperationId === null ? () => void preview.refetch() : undefined}
        retrying={preview.isFetching}
        warnings={showFallbackWarning
          ? [
            `This version will be deleted from Plex only. ${
              preview.data?.arrReason ?? `No verified ${arrLabel} destination is available.`
            } It may be downloaded again if it remains monitored.`,
          ]
          : []}
      />
      {blockingOperationId && (
        <div className="alert alert-warning mt-2 items-center py-2 text-sm">
          <span className="min-w-0 flex-1">
            An earlier deletion for this item still needs attention.
          </span>
          <Link
            to="/deletion-operations/$id"
            params={{ id: blockingOperationId }}
            className="btn btn-ghost btn-xs shrink-0"
          >
            Review deletion
          </Link>
        </div>
      )}
      {wouldDeleteAll && (
        <p className="mt-2 text-sm text-warning">
          {item.mediaType === "movie"
            ? `This selection removes “${item.title}” entirely.`
            : "At least one version must be kept — uncheck one to continue."}
        </p>
      )}
      {error != null && blockingOperationId === null && (
        <p className="mt-2 text-sm text-error">
          {error instanceof Error ? error.message : "Delete failed"}
        </p>
      )}

      <DeletionDialogFooter
        cancelButtonRef={cancelButtonRef}
        pending={pending}
        preparing={showPreviewLoading}
        confirmDisabled={confirmDisabled}
        confirmLabel={
          <>
            Delete {checkedCount} version{checkedCount === 1 ? "" : "s"} (
            {formatKilobytes(freedSize)})
          </>
        }
        onCancel={onCancel}
        onConfirm={() =>
          onConfirm({
            mediaIds,
            deleteWholeItem: selection.deleteWholeItem,
            deleteFromArr: effectiveDeleteFromArr && arrAvailable,
            cleanupDownloads: effectiveDeleteFromArr && arrAvailable && cleanupDownloads,
            cleanupMediaIds,
            ...(pathAdoption?.planFingerprint
              ? { planFingerprint: pathAdoption.planFingerprint }
              : {}),
            ...(pathConsentRequired ? { allowRadarrMovieRemoval } : {}),
          })}
      />
    </DeletionModalShell>
  );
}
