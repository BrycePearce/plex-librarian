import { OPTIONAL_DELETION_DESTINATIONS } from "../../../../shared/deletionPolicy.ts";
import { DeletionSetupLink } from "./DeletionSetupLink.tsx";
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
  currentLocationOwnershipProblem,
  downloadCleanupDestinationVisible,
  effectiveArrSelection,
  eligibleDownloadCleanupItems,
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
  const [deleteFromArr, setDeleteFromArr] = useState<boolean>(OPTIONAL_DELETION_DESTINATIONS.arr);
  const [cleanupDownloads, setCleanupDownloads] = useState<boolean>(
    OPTIONAL_DELETION_DESTINATIONS.qbittorrent,
  );
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
    // This response contains every destination scope; choices select its evidence locally.
    queryKey: queryKeys.downloadCleanupPreview.forItems(libraryKey, ratingKeys),
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
  const cleanupDestinationPreview = preview.data
    ? {
      ...preview.data,
      items: preview.data.items.map((item) =>
        effectiveDeleteFromArr ? item : {
          ...item,
          status: item.qbittorrentOnlyStatus ?? item.status,
          cleanupFingerprint: item.qbittorrentOnlyFingerprint,
        }
      ),
    }
    : undefined;
  const cleanupEligibleItems = eligibleDownloadCleanupItems(
    cleanupDestinationPreview,
    false,
    false,
  );
  const cleanupEligibleCount = cleanupEligibleItems.length;
  const cleanupDestinationVisible = downloadCleanupDestinationVisible(
    cleanupDestinationPreview,
    false,
  );
  const defaultOrphanOnlyCleanup = false;
  const cleanupAuthorizationKey = cleanupEligibleCount > 0 &&
      cleanupEligibleItems.every((item) => item.cleanupFingerprint)
    ? JSON.stringify(
      cleanupEligibleItems.map((item) => [item.ratingKey, item.cleanupFingerprint]).sort(),
    )
    : null;
  const effectiveCleanupDownloads = cleanupDownloads && cleanupAuthorizationKey !== null &&
    acceptedCleanupKeyRef.current === cleanupAuthorizationKey;
  const cleanupProblems =
    cleanupDestinationPreview?.items.filter((item) =>
      item.status !== "resolved" || item.downloadJobs.length === 0 && !item.noJobReason
    ) ?? [];
  const ownershipProblems = preview.data?.items.flatMap((item) => {
    const problem = currentLocationOwnershipProblem(
      item,
      effectiveDeleteFromArr,
      cleanupDownloads,
    );
    return problem.blocked ? [{ ...item, ownershipReason: problem.reason }] : [];
  }) ?? [];
  useEffect(() => {
    cleanupDefaultsKeyRef.current = null;
    acceptedCleanupKeyRef.current = null;
    setDeleteFromArr(OPTIONAL_DELETION_DESTINATIONS.arr);
    setCleanupDownloads(false);
    setCleanupConsentChanged(false);
    setPreviewMode("basic");
  }, [selectionKey]);
  useEffect(() => {
    if (!preview.data || preview.isFetching || preview.isError) return;
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
    preview.isFetching,
    preview.isError,
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
    setDeleteFromArr(OPTIONAL_DELETION_DESTINATIONS.arr);
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
    preview: preview.isFetching ? "loading" : preview.isError ? "error" : "ready",
    semanticBlock: cleanupConsentChanged || ownershipProblems.length > 0 ||
      (deleteFromArr && (!preview.data?.coordinatedConfigured || arrProblems.length > 0)) ||
      (cleanupDownloads && (!effectiveCleanupDownloads || cleanupEligibleCount !== items.length)),
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
          Librarian requests deletion through the selected services. Actual disk space recovered may
          differ. This cannot be undone.
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
            <DeletionSetupLink reason={ownershipProblems[0]?.ownershipReason} />
            <DeletionPreviewStatus
              error={preview.isError
                ? preview.error.message
                : ownershipProblems[0]?.ownershipReason ?? null}
              onRetry={() => void preview.refetch()}
              retrying={preview.isFetching}
              warnings={[
                ...(deleteFromArr && arrProblems.length > 0
                  ? [
                    `${arrProblems.length} ${
                      arrProblems.length === 1 ? "item has" : "items have"
                    } no verified Arr destination. Review the selection or explicitly turn off ${arrLabel} to continue with Plex only.`,
                  ]
                  : []),
                ...(effectiveCleanupDownloads && cleanupProblems.length > 0
                  ? [
                    `qBittorrent deletion could not be verified for ${cleanupProblems.length} ${
                      cleanupProblems.length === 1 ? "item" : "items"
                    }: ${
                      cleanupProblems[0]?.reason ??
                        "No verified qBittorrent job is available"
                    }`,
                  ]
                  : []),
                ...(cleanupConsentChanged
                  ? [
                    "Preview changed. Select Delete from qBittorrent again, or choose Keep qBittorrent files.",
                  ]
                  : []),
              ]}
            />
            {cleanupConsentChanged && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={pending || preview.isFetching}
                onClick={() => setCleanupConsentChanged(false)}
              >
                Keep qBittorrent files
              </button>
            )}
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
            {cleanupDownloads &&
              cleanupDestinationPreview?.items.some((item) => item.noJobReason) && (
              <p className="mt-2 text-xs">
                Some selected media has no matching live qBittorrent job. Those items have no
                qBittorrent deletion target.
              </p>
            )}
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
            keepDownloads={preview.data?.items.some((item) => item.downloadJobs.length > 0) ===
                true &&
              !effectiveCleanupDownloads}
            options={[
              ...(arrDestination.visible || deleteFromArr
                ? [{
                  id: "arr" as const,
                  service: arrService,
                  label: `Delete from ${arrLabel}`,
                  info: arrService === "sonarr"
                    ? "Delete current matched Sonarr media. Verified qBittorrent files are kept unless qBittorrent is also selected."
                    : `Delete the selected media and its files from ${arrLabel}.`,
                  checked: deleteFromArr,
                  disabled: pending || preview.isFetching,
                  warning: arrProblems.length > 0,
                  onChange: (checked: boolean) => {
                    setDeleteFromArr(checked);
                  },
                }]
                : []),
              ...(cleanupDestinationVisible || cleanupDownloads
                ? [{
                  id: "cleanup" as const,
                  service: "qbittorrent" as const,
                  label: "Delete from qBittorrent",
                  info:
                    "Delete matching torrents and their files. Only verified matches are deleted; unselected media and shared downloads are protected.",
                  checked: cleanupDownloads,
                  disabled: pending || preview.isFetching,
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
            confirmLabel="Confirm deletion"
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
                    const fingerprint = effectiveCleanupDownloads
                      ? (effectiveDeleteFromArr
                        ? itemPreview?.cleanupFingerprint
                        : itemPreview?.qbittorrentOnlyFingerprint)
                      : (effectiveDeleteFromArr
                        ? itemPreview?.sonarrCleanupFingerprint
                        : itemPreview?.plexOnlyFingerprint);
                    return fingerprint ? [[item.ratingKey, fingerprint]] : [];
                  }),
                ),
              })}
          />
        }
      />
    </DeletionModalShell>
  );
}
