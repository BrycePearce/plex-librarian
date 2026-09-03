import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
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
  AdvancedDeletionTree,
  DeletionServiceMarks,
} from "../../features/mediaDeletion/DeletionTree.tsx";
import { duplicateMovieDeletionCandidate } from "../../features/mediaDeletion/types.ts";
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
import { cleanupConsentInvalidated } from "../../features/mediaDeletion/deletionPreviewState.ts";
import {
  defaultVersionSelection,
  versionArrDestinationCopy,
  versionDestinationOptionVisibility,
  versionDestinationState,
  versionPlexFallbackWarning,
  versionRadarrPathOverride,
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
    cleanupPreviewFingerprint?: string;
    planFingerprint?: string;
    allowRadarrRetainedPathManagement?: boolean;
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
  const [useRadarrPathOverride, setUseRadarrPathOverride] = useState(false);
  const wholeItemDefaultsKeyRef = useRef<string | null>(null);
  const acceptedWholeItemCleanupFingerprintRef = useRef<string | null>(null);
  const queryClient = useQueryClient();

  useLayoutEffect(() => {
    if (item && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [dialogRef, item]);

  useEffect(() => {
    setSelectionState({ itemKey, checked: defaultChecked });
    setPreviewModeState({ itemKey, mode: "basic" });
  }, [defaultChecked, itemKey]);

  const mediaIds = useMemo(() => [...checked].sort((a, b) => a - b), [checked]);
  const selection = item ? versionSelectionSemantics(item.mediaType, item.versions, checked) : {
    selectedVersions: [],
    wouldDeleteAll: false,
    deleteWholeItem: false,
    blocked: false,
  };
  const deletingWholeMovie = selection.deleteWholeItem;
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
      true,
    ),
    queryFn: () =>
      api.duplicates.versionDeletionPreview(item!.mediaType, ratingKey, mediaIds, true),
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
    if (!deletingWholeMovie) {
      setDeleteFromArr(destination.arrSelectedByDefault);
      setCleanupDownloads(false);
    }
    setUseRadarrPathOverride(false);
  }, [
    item,
    mediaIds.join("|"),
    preview.data?.arrConfigured,
    preview.data?.arrStatus,
    preview.data?.arrReassignStatus,
    preview.data?.radarrPathOverride?.planFingerprint,
    deletingWholeMovie,
  ]);

  const wholeItemPreview = useQuery({
    queryKey: queryKeys.downloadCleanupPreview.forItems(item?.libraryKey ?? "", [ratingKey]),
    queryFn: () => api.libraries.downloadCleanupPreview(item!.libraryKey, [ratingKey]),
    enabled: deletingWholeMovie,
    retry: false,
    staleTime: 15_000,
  });
  const wholeItemPreviewEntry = wholeItemPreview.data?.items[0];
  const wholeItemCleanupAvailable = wholeItemPreviewEntry?.status === "resolved" &&
    wholeItemPreviewEntry.downloadJobs.length > 0;
  const wholeItemCleanupFingerprint = wholeItemCleanupAvailable
    ? wholeItemPreviewEntry?.cleanupFingerprint ?? null
    : null;
  const effectiveCleanupDownloads = selection.deleteWholeItem
    ? cleanupDownloads && wholeItemCleanupFingerprint !== null &&
      acceptedWholeItemCleanupFingerprintRef.current === wholeItemCleanupFingerprint
    : cleanupDownloads;
  const wholeItemArrAvailable = wholeItemPreviewEntry?.arrStatus === "resolved" &&
    wholeItemPreviewEntry.arrTargets.length > 0;
  const showWholeItemPreviewLoading = useDelayedFlag(wholeItemPreview.isLoading, 250);
  const wholeItemDefaultsKey = deletingWholeMovie ? `${itemKey}:${mediaIds.join("|")}` : null;
  useEffect(() => {
    if (!wholeItemDefaultsKey) {
      wholeItemDefaultsKeyRef.current = null;
      acceptedWholeItemCleanupFingerprintRef.current = null;
      return;
    }
    if (!wholeItemPreview.data) return;
    if (wholeItemDefaultsKeyRef.current !== wholeItemDefaultsKey) {
      wholeItemDefaultsKeyRef.current = wholeItemDefaultsKey;
      acceptedWholeItemCleanupFingerprintRef.current = wholeItemCleanupFingerprint;
      setCleanupDownloads(wholeItemCleanupFingerprint !== null);
      setDeleteFromArr(wholeItemArrAvailable);
      return;
    }
    if (
      cleanupConsentInvalidated(
        cleanupDownloads,
        wholeItemCleanupFingerprint,
        acceptedWholeItemCleanupFingerprintRef.current,
      )
    ) {
      acceptedWholeItemCleanupFingerprintRef.current = null;
      setCleanupDownloads(false);
    }
    if (!wholeItemArrAvailable) setDeleteFromArr(false);
  }, [
    wholeItemDefaultsKey,
    wholeItemPreview.data,
    wholeItemCleanupAvailable,
    wholeItemCleanupFingerprint,
    wholeItemArrAvailable,
    cleanupDownloads,
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

  const wholeItemCandidate = item.mediaType === "movie"
    ? duplicateMovieDeletionCandidate(item)
    : null;
  const selectedVersions = selection.selectedVersions;
  const checkedCount = checked.size;
  const wouldDeleteAll = selection.wouldDeleteAll;
  const freedSize = selectedVersions.reduce((sum, version) => sum + (version.fileSize ?? 0), 0);
  const arrLabel = item.mediaType === "movie" ? "Radarr" : "Sonarr";
  const arrService = item.mediaType === "movie" ? ("radarr" as const) : ("sonarr" as const);
  const destinations = versionDestinationState(preview.data);
  const arrAvailable = destinations.arrAvailable;
  const effectiveArrAvailable = selection.deleteWholeItem ? wholeItemArrAvailable : arrAvailable;
  const arrReassignAvailable = destinations.arrReassignAvailable;
  const cleanupAvailable = selection.deleteWholeItem
    ? wholeItemCleanupAvailable
    : destinations.cleanupAvailable;
  const pathAdoption = preview.data?.radarrPathAdoption;
  const pathOverride = versionRadarrPathOverride(preview.data) ?? undefined;
  const pathConsentRequired = pathAdoption?.mode === "remove_from_radarr";
  const destinationOptionVisibility = versionDestinationOptionVisibility(preview.data);
  const destinationOptionsVisible = selection.deleteWholeItem || destinationOptionVisibility.arr ||
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
  // This opt-out is intentionally movie-only. Single-episode deletion keeps its
  // existing automatic Sonarr safety path; the season workflow owns explicit modes.
  const effectiveDeleteFromArr = item.mediaType === "movie"
    ? deleteFromArr
    : arrReassignAvailable || deleteFromArr;
  const showFallbackWarning = effectiveDeleteFromArr
    ? versionPlexFallbackWarning(preview.data)
    : preview.data?.arrSelectionMatched === true || arrReassignAvailable;
  const reassignActive = preview.data?.arrReassignStatus === "resolved";
  const pathReassignmentActive = reassignActive || useRadarrPathOverride;
  const arrDestinationCopy = versionArrDestinationCopy(
    preview.data,
    arrLabel,
    arrReassignAvailable,
    item.mediaType === "movie",
    effectiveDeleteFromArr && !useRadarrPathOverride,
    item.versions.length - selectedVersions.length,
  );
  const cleanupMediaIds = !selection.deleteWholeItem && cleanupDownloads && cleanupAvailable &&
      !pathReassignmentActive
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
    preview: selection.deleteWholeItem
      ? wholeItemPreview.isError
        ? "error"
        : wholeItemPreview.isLoading || !wholeItemPreview.data
        ? "loading"
        : "ready"
      : preview.isError
      ? "error"
      : preview.isLoading || !preview.data
      ? "loading"
      : "ready",
    semanticBlock: selection.blocked,
  }) ||
    (cleanupDownloads && !cleanupAvailable);
  const activePreviewError = selection.deleteWholeItem ? wholeItemPreview.error : preview.error;
  const blockingOperationId = deletionOperationIdFromError(activePreviewError) ??
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
                      selection.deleteWholeItem && wholeItemCandidate
                        ? (
                          <DeletionServiceMarks
                            item={wholeItemCandidate}
                            preview={wholeItemPreviewEntry}
                            deleteFromArr={effectiveDeleteFromArr}
                            cleanupDownloads={effectiveCleanupDownloads}
                          />
                        )
                        : (
                          <VersionDeletionServiceMarks
                            preview={preview.data}
                            mediaId={version.mediaId}
                            deleteFromArr={effectiveDeleteFromArr}
                            cleanupDownloads={effectiveCleanupDownloads}
                          />
                        )
                    )
                    : undefined}
                  size={version.fileSize != null ? formatKilobytes(version.fileSize) : "—"}
                />
              );
            })}
          </BasicDeletionList>
        }
        advanced={selection.deleteWholeItem && wholeItemCandidate
          ? (
            <AdvancedDeletionTree
              items={[wholeItemCandidate]}
              plexPreviews={new Map(
                wholeItemPreviewEntry ? [[ratingKey, wholeItemPreviewEntry]] : [],
              )}
              deleteFromArr={effectiveDeleteFromArr}
              cleanupDownloads={effectiveCleanupDownloads}
              loading={wholeItemPreview.isLoading}
            />
          )
          : (
            <AdvancedVersionDeletionTree
              title={item.mediaType === "movie"
                ? item.title
                : `E${String(item.episodeIndex).padStart(2, "0")} — ${item.episodeTitle}`}
              ancestors={item.mediaType === "episode"
                ? [item.showTitle, `Season ${item.seasonIndex}`]
                : undefined}
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
              cleanupDownloads={effectiveCleanupDownloads}
              loading={preview.isLoading}
              onToggleVersion={toggle}
            />
          )}
      />

      {(selection.deleteWholeItem ? wholeItemPreview.data : preview.data) &&
        destinationOptionsVisible && (
        <DestinationOptions
          options={[
            ...((selection.deleteWholeItem || destinationOptionVisibility.arr)
              ? [
                {
                  id: "arr" as const,
                  service: arrService,
                  label: arrDestinationCopy.label,
                  info: selection.deleteWholeItem
                    ? (wholeItemPreviewEntry?.arrReason ??
                      (wholeItemArrAvailable
                        ? `Deletes the managed title and its files through ${arrLabel}.`
                        : `No verified ${arrLabel} destination is available`))
                    : arrDestinationCopy.info,
                  checked: effectiveDeleteFromArr && effectiveArrAvailable &&
                    !useRadarrPathOverride,
                  disabled: pending ||
                    (selection.deleteWholeItem &&
                      (wholeItemPreview.isLoading || !wholeItemArrAvailable)) ||
                    (item.mediaType === "episode" && arrReassignAvailable &&
                      !useRadarrPathOverride),
                  warning: false,
                  onChange: (checked: boolean) => {
                    if (checked && useRadarrPathOverride) {
                      setUseRadarrPathOverride(false);
                      return;
                    }
                    setDeleteFromArr(checked);
                    if (!checked && !selection.deleteWholeItem) setCleanupDownloads(false);
                  },
                },
              ]
              : []),
            ...(pathOverride
              ? [
                {
                  id: "arr-path-override" as const,
                  service: "radarr" as const,
                  label: "Use remaining folder in Radarr",
                  info: "Break-glass option: this location is not a verified ordinary Radarr " +
                    `library folder. Radarr will manage ${pathOverride.proposedMoviePath} and may ` +
                    "later rename, upgrade, move, or delete files there.",
                  checked: useRadarrPathOverride,
                  disabled: pending || useRadarrPathOverride,
                  warning: false,
                  onChange: (checked: boolean) => {
                    if (!checked) return;
                    setUseRadarrPathOverride(true);
                    setCleanupDownloads(false);
                  },
                },
              ]
              : []),
            ...((selection.deleteWholeItem || destinationOptionVisibility.cleanup)
              ? [
                {
                  id: "cleanup" as const,
                  service: "qbittorrent" as const,
                  label: "qBittorrent",
                  info: selection.deleteWholeItem
                    ? (wholeItemPreviewEntry?.reason ??
                      (wholeItemCleanupAvailable
                        ? "Deletes the independently verified qBittorrent job and its downloaded payload."
                        : "No verified qBittorrent job is available"))
                    : pathReassignmentActive
                    ? `Unavailable while ${arrLabel} is reassigning its record to the retained version.`
                    : "Deletes the verified qBittorrent job and its downloaded files along with " +
                      "the selected Plex version.",
                  checked: effectiveCleanupDownloads,
                  disabled: pending ||
                    (selection.deleteWholeItem
                      ? wholeItemPreview.isLoading || !wholeItemCleanupAvailable
                      : !deleteFromArr || pathReassignmentActive),
                  warning: !cleanupAvailable ||
                    (!selection.deleteWholeItem && pathReassignmentActive),
                  onChange: (checked: boolean) => {
                    if (selection.deleteWholeItem) {
                      acceptedWholeItemCleanupFingerprintRef.current = checked
                        ? wholeItemCleanupFingerprint
                        : null;
                    }
                    setCleanupDownloads(checked);
                  },
                },
              ]
              : []),
          ]}
        />
      )}

      {effectiveDeleteFromArr && pathAdoption && pathAdoption.mode === "adopt_safe_path" && (
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

      <DeletionPreviewStatus
        error={activePreviewError && blockingOperationId === null
          ? activePreviewError.message
          : null}
        onRetry={blockingOperationId === null
          ? () => void (selection.deleteWholeItem ? wholeItemPreview.refetch() : preview.refetch())
          : undefined}
        retrying={selection.deleteWholeItem ? wholeItemPreview.isFetching : preview.isFetching}
        warnings={showFallbackWarning
          ? [
            effectiveDeleteFromArr
              ? `This version will be deleted from Plex only. ${
                preview.data?.arrReason ?? `No verified ${arrLabel} destination is available.`
              } It may be downloaded again if it remains monitored.`
              : `${arrLabel} will not be updated. Plex will delete the selected file directly, ` +
                `and it may be downloaded again if it remains monitored.`,
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
        preparing={selection.deleteWholeItem ? showWholeItemPreviewLoading : showPreviewLoading}
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
            deleteFromArr: effectiveDeleteFromArr && effectiveArrAvailable,
            cleanupDownloads: selection.deleteWholeItem
              ? effectiveCleanupDownloads
              : effectiveDeleteFromArr && arrAvailable && cleanupDownloads,
            cleanupMediaIds,
            ...(selection.deleteWholeItem && effectiveCleanupDownloads &&
                wholeItemCleanupFingerprint
              ? { cleanupPreviewFingerprint: wholeItemCleanupFingerprint }
              : {}),
            ...(effectiveDeleteFromArr &&
                (useRadarrPathOverride ? pathOverride : pathAdoption)?.planFingerprint
              ? {
                planFingerprint: (useRadarrPathOverride ? pathOverride : pathAdoption)!
                  .planFingerprint,
              }
              : {}),
            ...(effectiveDeleteFromArr && useRadarrPathOverride
              ? { allowRadarrRetainedPathManagement: true }
              : effectiveDeleteFromArr && pathConsentRequired
              ? { allowRadarrMovieRemoval: true }
              : {}),
          })}
      />
    </DeletionModalShell>
  );
}
