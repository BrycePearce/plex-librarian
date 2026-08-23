import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import type { ServiceIconName } from "../../components/ServiceIcons.tsx";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { formatKilobytes } from "../../lib/format.ts";
import {
  arrCleanupTargetImpact,
  ArrDeletionWarning,
  DestinationOptions,
} from "./DeletionPlanSummary.tsx";
import { AdvancedDeletionTree, DeletionServiceMarks } from "./DeletionTree.tsx";
import {
  arrDestinationState,
  effectiveArrSelection,
  shouldUseArrByDefault,
} from "./deletionPreviewState.ts";
import type { WholeItemDeletionCandidate } from "./types.ts";
import { deletionImpact } from "./deletionImpact.ts";
import {
  BasicDeletionList,
  BasicDeletionRow,
  DeletionDialogFooter,
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
  }) => void;
  onCancel: () => void;
}) {
  const [deleteFromArr, setDeleteFromArr] = useState(true);
  const [cleanupDownloads, setCleanupDownloads] = useState(false);
  const [previewMode, setPreviewMode] = useState<"basic" | "advanced">("basic");
  const cleanupDefaultsKeyRef = useRef<string | null>(null);
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
  const cleanupEligibleItems =
    preview.data?.items.filter((item) =>
      item.status === "resolved" && item.downloadJobs.length > 0
    ) ?? [];
  const downloadJobs = [...new Map(
    cleanupEligibleItems.flatMap((item) => item.downloadJobs).map((job) => [
      `${job.instanceKey}:${job.jobId}`,
      job,
    ]),
  ).values()];
  const cleanupEligibleCount = cleanupEligibleItems.length;
  const coordinatedRatingKeys = preview.data?.coordinatedConfigured
    ? preview.data.items.filter((item) => item.arrStatus === "resolved").map((
      item,
    ) => item.ratingKey)
    : [];
  const arrDestination = arrDestinationState(preview.data);
  const arrProblems = arrDestination.problems;
  const cleanupProblems =
    preview.data?.items.filter((item) =>
      item.status !== "resolved" || item.downloadJobs.length === 0
    ) ?? [];
  const arrService: ServiceIconName = items[0]?.type === "show" ? "sonarr" : "radarr";
  const arrLabel = arrService === "sonarr" ? "Sonarr" : "Radarr";
  // Query results and effects commit in separate renders. Suppress an obsolete Arr
  // selection immediately when no coordinated destination exists so the displayed
  // deletion plan stays accurate before the state-syncing effect catches up.
  const effectiveDeleteFromArr = effectiveArrSelection(deleteFromArr, preview.data);
  const arrDeletionImpacts = effectiveDeleteFromArr
    ? preview.data?.items.flatMap((item) =>
      item.arrStatus === "resolved" ? item.arrTargets.map(arrCleanupTargetImpact) : []
    ) ?? []
    : [];
  const cleanupUsesQbittorrent = downloadJobs.length > 0;
  useEffect(() => {
    cleanupDefaultsKeyRef.current = null;
    setDeleteFromArr(true);
    setCleanupDownloads(false);
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
      setCleanupDownloads(cleanupEligibleCount > 0);
      return;
    }
    // A refetch may invalidate a destination, but must not silently reverse a
    // user's explicit choice while that destination remains available.
    if (cleanupEligibleCount === 0) setCleanupDownloads(false);
  }, [preview.data, cleanupEligibleCount, selectionKey]);
  const cancel = () => {
    setDeleteFromArr(preview.data?.coordinatedConfigured ?? true);
    setCleanupDownloads(cleanupEligibleCount > 0);
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
            {formatKilobytes(totalSize)}
          </span>{" "}
          {unknownSizeCount > 0 && (
            <>
              plus {unknownSizeCount} unknown-size {unknownSizeCount === 1 ? "item" : "items"}
            </>
          )}
          will be permanently removed. This cannot be undone.
        </>
      }
    >
      <DeletionPreview
        mode={previewMode}
        onModeChange={setPreviewMode}
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
                      cleanupDownloads={cleanupDownloads}
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
            cleanupDownloads={cleanupDownloads}
            loading={preview.isLoading}
          />
        }
      />
      {hasMultiVersionItems && (
        <p className="mt-1.5 text-xs text-base-content/40">
          Items marked with multiple versions lose all of them here. To remove just one, use the
          {" "}
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
      {error != null && (
        <p className="text-error text-sm">
          {error instanceof Error ? error.message : "Delete failed"}
        </p>
      )}
      <DestinationOptions
        options={[
          {
            id: "arr" as const,
            service: arrService,
            label: arrLabel,
            info: arrProblems[0]?.arrReason ??
              (coordinatedRatingKeys.length > 0
                ? `Deletes the managed title and its files through ${arrLabel}.`
                : `No verified ${arrLabel} destination is available`),
            checked: effectiveDeleteFromArr,
            disabled: pending || preview.isLoading ||
              coordinatedRatingKeys.length === 0,
            warning: arrProblems.length > 0,
            onChange: (checked: boolean) => {
              setDeleteFromArr(checked);
            },
          },
          {
            id: "cleanup" as const,
            service: "qbittorrent" as const,
            label: "qBittorrent",
            info: cleanupProblems[0]?.reason ??
              (cleanupUsesQbittorrent
                ? "Removes verified qBittorrent jobs and asks qBittorrent to delete their downloaded files. Verified orphan hardlinks are also removed."
                : "No verified qBittorrent job is available"),
            checked: cleanupDownloads,
            disabled: pending || preview.isLoading || cleanupEligibleCount === 0,
            warning: cleanupProblems.length > 0,
            onChange: setCleanupDownloads,
          },
        ]}
      />
      <ArrDeletionWarning service={arrService} impacts={arrDeletionImpacts} />

      <DeletionPreviewStatus
        error={preview.isError ? preview.error.message : null}
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
          ...(cleanupProblems.length > 0
            ? [
              `qBittorrent cleanup could not be verified for ${cleanupProblems.length} ${
                cleanupProblems.length === 1 ? "item" : "items"
              }: ${cleanupProblems[0]?.reason ?? "No verified qBittorrent job is available"}`,
            ]
            : []),
        ]}
      />

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
            cleanupDownloadRatingKeys: cleanupDownloads
              ? cleanupEligibleItems.map((item) => item.ratingKey)
              : [],
          })}
      />
    </DeletionModalShell>
  );
}
