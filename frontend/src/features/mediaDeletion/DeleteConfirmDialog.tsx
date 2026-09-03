import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import type { ServiceIconName } from "../../components/ServiceIcons.tsx";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { DestinationOptions } from "./DeletionPlanSummary.tsx";
import { AdvancedDeletionTree, DeletionServiceMarks } from "./DeletionTree.tsx";
import {
  arrDestinationState,
  cleanupConsentInvalidated,
  downloadCleanupDestinationVisible,
  effectiveArrSelection,
  eligibleDownloadCleanupItems,
  selectedSonarrOwnershipProblems,
  shouldUseArrByDefault,
  SONARR_OWNED_PATH_COPY,
} from "./deletionPreviewState.ts";
import type { WholeItemDeletionCandidate } from "./types.ts";
import { deletionImpact } from "./deletionImpact.ts";
import {
  BasicDeletionList,
  BasicDeletionRow,
  DeletionDialogFooter,
  DeletionDialogLayout,
  DeletionModalShell,
  DeletionPreview,
  DeletionPreviewStatus,
  useDelayedFlag,
  useDeletionDialogCancelFocus,
} from "./DeletionDialog.tsx";
import { deletionConfirmationBlocked } from "./deletionConfirmation.ts";
import "../../components/dataSurfaces.css";

export function DeleteConfirmDialog({
  dialogRef,
  embedded = false,
  libraryKey,
  items,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  embedded?: boolean;
  libraryKey: string;
  items: WholeItemDeletionCandidate[];
  pending: boolean;
  error: unknown;
  onConfirm: (plan: {
    coordinatedRatingKeys: string[];
    cleanupDownloadRatingKeys: string[];
    cleanupPreviewFingerprints: Record<string, string>;
  }) => void;
  onCancel: () => void;
}) {
  const [deleteFromArr, setDeleteFromArr] = useState(true);
  const [cleanupDownloads, setCleanupDownloads] = useState(false);
  const [cleanupConsentChanged, setCleanupConsentChanged] = useState(false);
  const [previewMode, setPreviewMode] = useState<"basic" | "advanced">("basic");
  const cleanupDefaultsKeyRef = useRef<string | null>(null);
  const acceptedCleanupKeyRef = useRef<string | null>(null);
  const ratingKeys = useMemo(
    () => items.map((item) => item.ratingKey),
    [items],
  );
  const selectionKey = `${libraryKey}:${ratingKeys.join("|")}`;
  const cancelButtonRef = useDeletionDialogCancelFocus(
    dialogRef,
    selectionKey,
  );
  const preview = useQuery({
    queryKey: queryKeys.downloadCleanupPreview.forItems(
      libraryKey,
      ratingKeys,
    ),
    queryFn: () => api.libraries.downloadCleanupPreview(libraryKey, ratingKeys),
    enabled: ratingKeys.length > 0,
    staleTime: 15_000,
    retry: false,
  });
  const showPreviewLoading = useDelayedFlag(preview.isLoading, 350);
  const previewByRatingKey = useMemo(
    () => new Map(preview.data?.items.map((item) => [item.ratingKey, item]) ?? []),
    [preview.data],
  );
  const coordinatedRatingKeys = preview.data?.coordinatedConfigured
    ? preview.data.items.filter((item) => item.arrStatus === "resolved").map((
      item,
    ) => item.ratingKey)
    : [];
  const arrDestination = arrDestinationState(preview.data);
  const arrProblems = arrDestination.problems;
  const arrService: ServiceIconName = items[0]?.type === "show" ? "sonarr" : "radarr";
  const arrLabel = arrService === "sonarr" ? "Sonarr" : "Radarr";
  // Query results and effects commit in separate renders. Suppress an obsolete Arr
  // selection immediately when no coordinated destination exists so the displayed
  // deletion plan stays accurate before the state-syncing effect catches up.
  const effectiveDeleteFromArr = effectiveArrSelection(deleteFromArr, preview.data);
  const cleanupEligibleItems = eligibleDownloadCleanupItems(
    preview.data,
    false,
    false,
  );
  const cleanupEligibleCount = cleanupEligibleItems.length;
  const cleanupDestinationVisible = downloadCleanupDestinationVisible(
    preview.data,
    false,
  );
  const defaultOrphanOnlyCleanup = false;
  const orphanOnlyDestination = false;
  const cleanupAuthorizationKey = cleanupEligibleCount > 0 &&
      cleanupEligibleItems.every((item) => item.cleanupFingerprint)
    ? JSON.stringify(
      cleanupEligibleItems.map((item) => [item.ratingKey, item.cleanupFingerprint]).sort(),
    )
    : null;
  const effectiveCleanupDownloads = cleanupDownloads && cleanupAuthorizationKey !== null &&
    acceptedCleanupKeyRef.current === cleanupAuthorizationKey;
  const cleanupProblems =
    preview.data?.items.filter((item) =>
      item.status !== "resolved" || item.downloadJobs.length === 0
    ) ?? [];
  const sonarrOwnershipProblems = selectedSonarrOwnershipProblems(
    preview.data,
    effectiveDeleteFromArr && arrService === "sonarr",
  );
  useEffect(() => {
    cleanupDefaultsKeyRef.current = null;
    acceptedCleanupKeyRef.current = null;
    setDeleteFromArr(true);
    setCleanupDownloads(false);
    setCleanupConsentChanged(false);
    setPreviewMode("basic");
  }, [selectionKey]);
  useEffect(() => {
    // When Arr is configured but no selected title can be resolved, keep the Arr
    // destination selected so the explicit Plex-fallback acknowledgement below is
    // still required. Only switch to Plex-only automatically when this library has
    // no coordinated destination at all.
    if (preview.data && !shouldUseArrByDefault(preview.data)) {
      setDeleteFromArr(false);
    }
  }, [preview.data]);
  useEffect(() => {
    if (!preview.data) return;
    if (cleanupDefaultsKeyRef.current !== selectionKey) {
      cleanupDefaultsKeyRef.current = selectionKey;
      if (defaultOrphanOnlyCleanup && effectiveDeleteFromArr) {
        acceptedCleanupKeyRef.current = cleanupAuthorizationKey;
        setCleanupDownloads(true);
      }
      return;
    }
    // Consent is bound to the exact previewed paths and jobs. A materially changed
    // refetch requires another explicit choice; unchanged refetches preserve it.
    if (
      cleanupConsentInvalidated(
        cleanupDownloads,
        cleanupAuthorizationKey,
        acceptedCleanupKeyRef.current,
      )
    ) {
      acceptedCleanupKeyRef.current = null;
      setCleanupDownloads(false);
      setCleanupConsentChanged(true);
    }
  }, [
    preview.data,
    cleanupEligibleCount,
    cleanupAuthorizationKey,
    cleanupDownloads,
    selectionKey,
    defaultOrphanOnlyCleanup,
    effectiveDeleteFromArr,
  ]);
  const cancel = () => {
    cleanupDefaultsKeyRef.current = null;
    acceptedCleanupKeyRef.current = null;
    setDeleteFromArr(preview.data?.coordinatedConfigured ?? true);
    setCleanupDownloads(false);
    setCleanupConsentChanged(false);
    onCancel();
  };
  const { totalSize, unknownSizeCount } = deletionImpact(items);
  // Deleting here removes every synced Media version, not just one redundant copy.
  // Movies carry an exact version count; shows only carry an existence flag because
  // episode media versions are not rolled up per show. Keep both signals compact so a
  // page-sized selection remains scannable.
  const hasMultiVersionItems = items.some(
    (i) => (i.versions?.length ?? 0) >= 2 || i.hasDuplicateEpisodes === true,
  );
  const confirmDisabled = deletionConfirmationBlocked({
    pending,
    hasSelection: items.length > 0,
    preview: preview.isLoading ? "loading" : preview.isError ? "error" : "ready",
    semanticBlock: sonarrOwnershipProblems.length > 0,
  });

  return (
    <DeletionModalShell
      dialogRef={dialogRef}
      pending={pending}
      embedded={embedded}
      onClose={cancel}
      title={<>Delete {items.length} item{items.length === 1 ? "" : "s"}?</>}
      summary={
        <>
          <span className="font-semibold text-base-content">
            {formatKilobytes(totalSize)} logical media selected
          </span>{" "}
          {unknownSizeCount > 0 && (
            <>
              plus {unknownSizeCount} unknown-size {unknownSizeCount === 1 ? "item" : "items"}
            </>
          )}
          The selected items will be permanently removed. Actual disk space recovered may differ.
          {" "}
          This cannot be undone.
        </>
      }
    >
      <DeletionDialogLayout
        status={
          <>
            {error != null && (
              <p className="text-error text-sm">
                {error instanceof Error ? error.message : "Delete failed"}
              </p>
            )}
            <DeletionPreviewStatus
              error={preview.isError
                ? preview.error.message
                : sonarrOwnershipProblems[0]?.sonarrCleanupReason ?? null}
              onRetry={() => void preview.refetch()}
              retrying={preview.isFetching}
              warnings={[
                ...(preview.data?.coordinatedConfigured && arrProblems.length > 0
                  ? [
                    `${arrProblems.length} ${
                      arrProblems.length === 1 ? "item has" : "items have"
                    } no verified Arr destination. Plex and any independently selected qBittorrent cleanup will still run. ${
                      arrProblems.length === 1 ? "It" : "They"
                    } may be downloaded again if ${
                      arrProblems.length === 1 ? "it remains" : "they remain"
                    } monitored.`,
                  ]
                  : []),
                ...(effectiveCleanupDownloads && cleanupProblems.length > 0
                  ? [
                    `${
                      orphanOnlyDestination ? "Verified hardlink cleanup" : "Download cleanup"
                    } could not be verified for ${cleanupProblems.length} ${
                      cleanupProblems.length === 1 ? "item" : "items"
                    }: ${
                      cleanupProblems[0]?.reason ??
                        (orphanOnlyDestination
                          ? "No verified historical Sonarr hardlink is available"
                          : "No verified qBittorrent job is available")
                    }`,
                  ]
                  : []),
                ...(cleanupConsentChanged
                  ? [
                    "Preview updated. Review the cleanup option before continuing.",
                  ]
                  : []),
              ]}
            />
          </>
        }
        review={
          <>
            <DeletionPreview
              mode={previewMode}
              onModeChange={setPreviewMode}
              collapsible={!embedded}
              basic={
                <BasicDeletionList>
                  {items.map((item) => {
                    const versions = item.versions ?? [];
                    const isMultiVersion = versions.length >= 2;
                    const previewItem = previewByRatingKey.get(item.ratingKey);
                    return (
                      <BasicDeletionRow
                        key={item.ratingKey}
                        title={item.title}
                        titleText={item.title}
                        badges={
                          <>
                            {isMultiVersion && (
                              <span className="badge badge-warning badge-xs shrink-0">
                                {versions.length} versions
                              </span>
                            )}
                            {!isMultiVersion && item.hasDuplicateEpisodes && (
                              <span
                                className="inline-flex size-4 shrink-0 items-center justify-center text-warning"
                                title="This show contains episodes with multiple Plex versions"
                                role="img"
                                aria-label="Has duplicate episodes"
                              >
                                <Copy className="size-3" />
                              </span>
                            )}
                          </>
                        }
                        marks={
                          <DeletionServiceMarks
                            item={item}
                            preview={previewItem}
                            deleteFromArr={effectiveDeleteFromArr}
                            cleanupDownloads={effectiveCleanupDownloads}
                          />
                        }
                        size={item.fileSize != null ? formatKilobytes(item.fileSize) : "—"}
                      />
                    );
                  })}
                </BasicDeletionList>
              }
              advanced={
                <AdvancedDeletionTree
                  items={items}
                  plexPreviews={previewByRatingKey}
                  deleteFromArr={effectiveDeleteFromArr}
                  cleanupDownloads={effectiveCleanupDownloads}
                  loading={preview.isLoading}
                />
              }
            />
            {hasMultiVersionItems && (
              <p className="mt-1.5 text-xs text-base-content/40">
                Items marked with multiple versions lose all of them here. To remove just one, use
                the{" "}
                <Link
                  to="/duplicates"
                  search={{ type: "all", comparison: "all" }}
                  className="link link-primary"
                >
                  Duplicates page
                </Link>{" "}
                instead.
              </p>
            )}
          </>
        }
        destinations={
          <DestinationOptions
            options={[
              ...(coordinatedRatingKeys.length > 0
                ? [{
                  id: "arr" as const,
                  service: arrService,
                  label: arrLabel,
                  info: arrService === "sonarr"
                    ? SONARR_OWNED_PATH_COPY
                    : `Deletes the managed title and its files through ${arrLabel}.`,
                  checked: effectiveDeleteFromArr,
                  disabled: pending || preview.isLoading,
                  warning: arrProblems.length > 0,
                  onChange: (checked: boolean) => {
                    setDeleteFromArr(checked);
                  },
                }]
                : []),
              ...(cleanupDestinationVisible
                ? [{
                  id: "cleanup" as const,
                  service: orphanOnlyDestination ? "sonarr" as const : "qbittorrent" as const,
                  label: orphanOnlyDestination ? "Verified hardlink cleanup" : "Download cleanup",
                  info: orphanOnlyDestination
                    ? "Removes verified historical Sonarr import hardlinks. This remains available after the download job is gone and is included by default with whole-show Sonarr deletion."
                    : "Removes verified qBittorrent jobs and verified orphan hardlinks. Orphan-only cleanup remains available after the download job is gone.",
                  checked: effectiveCleanupDownloads,
                  disabled: pending || preview.isLoading,
                  warning: effectiveCleanupDownloads && cleanupProblems.length > 0,
                  onChange: (checked: boolean) => {
                    acceptedCleanupKeyRef.current = checked ? cleanupAuthorizationKey : null;
                    setCleanupDownloads(checked);
                    setCleanupConsentChanged(false);
                  },
                }]
                : []),
            ]}
          />
        }
        footer={
          <DeletionDialogFooter
            cancelButtonRef={cancelButtonRef}
            pending={pending}
            preparing={showPreviewLoading}
            confirmDisabled={confirmDisabled}
            confirmLabel="Delete permanently"
            onCancel={cancel}
            onConfirm={() =>
              onConfirm({
                coordinatedRatingKeys: effectiveDeleteFromArr ? coordinatedRatingKeys : [],
                cleanupDownloadRatingKeys: effectiveCleanupDownloads
                  ? cleanupEligibleItems.map((item) => item.ratingKey)
                  : [],
                cleanupPreviewFingerprints: Object.fromEntries(
                  items.flatMap((item) => {
                    const itemPreview = previewByRatingKey.get(item.ratingKey);
                    if (effectiveCleanupDownloads && itemPreview?.cleanupFingerprint) {
                      return [[item.ratingKey, itemPreview.cleanupFingerprint]];
                    }
                    if (
                      effectiveDeleteFromArr && item.type === "show" &&
                      itemPreview?.sonarrCleanupFingerprint
                    ) return [[item.ratingKey, itemPreview.sonarrCleanupFingerprint]];
                    return [];
                  }),
                ),
              })}
          />
        }
      />
    </DeletionModalShell>
  );
}
