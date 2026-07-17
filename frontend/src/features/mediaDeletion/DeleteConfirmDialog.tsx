import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { formatKilobytes } from "../../lib/format";
import { DestinationOptions } from "./DeletionPlanSummary";
import { AdvancedDeletionTree, DeletionServiceMarks } from "./DeletionTree";
import {
  arrDestinationState,
  shouldUseArrByDefault,
} from "./deletionPreviewState";
import type { WholeItemDeletionCandidate } from "./types";
import { deletionImpact } from "./deletionImpact";
import {
  BasicDeletionList,
  BasicDeletionRow,
  DeletionDialogFooter,
  DeletionModalShell,
  DeletionPreview,
  DeletionPreviewStatus,
  PlexFallbackAcknowledgement,
  useDeletionDialogCancelFocus,
} from "./DeletionDialog";
import { deletionConfirmationBlocked } from "./deletionConfirmation";
import "../../components/dataSurfaces.css";

export function DeleteConfirmDialog({
  dialogRef,
  libraryKey,
  items,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  libraryKey: string;
  items: WholeItemDeletionCandidate[];
  pending: boolean;
  error: unknown;
  onConfirm: (plan: {
    coordinatedRatingKeys: string[];
    cleanupDownloads: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const [deleteFromArr, setDeleteFromArr] = useState(true);
  const [cleanupDownloads, setCleanupDownloads] = useState(false);
  const [plexFallbackAcknowledged, setPlexFallbackAcknowledged] = useState(
    false,
  );
  const [previewMode, setPreviewMode] = useState<"basic" | "advanced">("basic");
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
  const previewByRatingKey = useMemo(
    () =>
      new Map(preview.data?.items.map((item) => [item.ratingKey, item]) ?? []),
    [preview.data],
  );
  const cleanupEligibleItems =
    preview.data?.items.filter((item) => item.status === "resolved") ?? [];
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
  const arrProblemKey = arrProblems.map((problem) => problem.ratingKey).sort()
    .join("|");
  const cleanupVerificationErrors =
    preview.data?.items.filter((item) =>
      item.arrStatus === "resolved" && item.status === "error"
    ) ?? [];
  const arrService = items[0]?.type === "show" ? "sonarr" : "radarr";
  const arrLabel = arrService === "sonarr" ? "Sonarr" : "Radarr";
  const arrOptionVisible = arrDestination.visible;
  const plexFallbackRequired = deleteFromArr && arrProblems.length > 0;
  const cleanupOptionVisible = arrOptionVisible &&
    (cleanupEligibleCount > 0 || cleanupVerificationErrors.length > 0);
  const cleanupUsesQbittorrent = downloadJobs.length > 0;
  useEffect(() => {
    setDeleteFromArr(true);
    setCleanupDownloads(false);
    setPlexFallbackAcknowledged(false);
    setPreviewMode("basic");
  }, [libraryKey, ratingKeys.join("|")]);
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
    if (cleanupEligibleCount === 0) setCleanupDownloads(false);
  }, [cleanupEligibleCount]);
  useEffect(() => {
    setPlexFallbackAcknowledged(false);
  }, [arrProblemKey]);
  const cancel = () => {
    setDeleteFromArr(preview.data?.coordinatedConfigured ?? true);
    setCleanupDownloads(false);
    setPlexFallbackAcknowledged(false);
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
    preview: preview.isLoading
      ? "loading"
      : preview.isError
      ? "error"
      : "ready",
    fallbackRequired: plexFallbackRequired,
    fallbackAcknowledged: plexFallbackAcknowledged,
  });

  return (
    <DeletionModalShell
      dialogRef={dialogRef}
      pending={pending}
      onClose={cancel}
      title={<>Delete {items.length} item{items.length === 1 ? "" : "s"}?</>}
      summary={
        <>
          <span className="font-semibold text-base-content">
            {formatKilobytes(totalSize)}
          </span>{" "}
          {unknownSizeCount > 0 && (
            <>
              plus {unknownSizeCount} unknown-size{" "}
              {unknownSizeCount === 1 ? "item" : "items"}
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
                      deleteFromArr={deleteFromArr}
                      cleanupDownloads={cleanupDownloads}
                    />
                  }
                  size={item.fileSize != null
                    ? formatKilobytes(item.fileSize)
                    : "—"}
                />
              );
            })}
          </BasicDeletionList>
        }
        advanced={
          <AdvancedDeletionTree
            items={items}
            plexPreviews={previewByRatingKey}
            deleteFromArr={deleteFromArr}
            cleanupDownloads={cleanupDownloads}
            loading={preview.isLoading}
          />
        }
      />
      {hasMultiVersionItems && (
        <p className="mt-1.5 text-xs text-base-content/40">
          Items marked with multiple versions lose all of them here. To remove
          just one, use the{" "}
          <Link
            to="/duplicates"
            search={{ type: "all" }}
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
      {(arrOptionVisible || cleanupOptionVisible) && (
        <DestinationOptions
          options={[
            ...(arrOptionVisible
              ? [{
                id: "arr" as const,
                service: arrService,
                label: arrLabel,
                info: arrProblems[0]?.arrReason ??
                  `Deletes the managed title and its files through ${arrLabel}.`,
                checked: deleteFromArr,
                disabled: pending || preview.isLoading ||
                  coordinatedRatingKeys.length === 0,
                warning: arrProblems.length > 0,
                onChange: (checked: boolean) => {
                  setDeleteFromArr(checked);
                  setPlexFallbackAcknowledged(false);
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
                info: cleanupVerificationErrors[0]?.reason ??
                  (cleanupUsesQbittorrent
                    ? "Removes verified qBittorrent jobs and asks qBittorrent to delete their downloaded files. Verified orphan hardlinks are also removed."
                    : "Removes downloaded files whose hardlink identity has been verified safely."),
                checked: cleanupDownloads,
                disabled: pending || preview.isLoading || !deleteFromArr ||
                  cleanupEligibleCount === 0,
                warning: cleanupVerificationErrors.length > 0,
                onChange: setCleanupDownloads,
              }]
              : []),
          ]}
        />
      )}

      <DeletionPreviewStatus
        loading={preview.isLoading}
        error={preview.isError ? preview.error.message : null}
        warnings={[
          ...(preview.data?.coordinatedConfigured && arrProblems.length > 0
            ? [
              `${arrProblems.length} ${
                arrProblems.length === 1 ? "item has" : "items have"
              } no verified Arr destination and will use Plex only. Review the Arr warning for details.`,
            ]
            : []),
          ...(cleanupVerificationErrors.length > 0
            ? [
              `Downloaded-file cleanup could not be verified for ${cleanupVerificationErrors.length} ${
                cleanupVerificationErrors.length === 1 ? "item" : "items"
              }: ${
                cleanupVerificationErrors[0]?.reason ??
                  "downloaded-file cleanup could not be verified"
              }`,
            ]
            : []),
        ]}
      />

      {plexFallbackRequired && (
        <PlexFallbackAcknowledgement
          checked={plexFallbackAcknowledged}
          pending={pending}
          onChange={setPlexFallbackAcknowledged}
        >
          Delete {arrProblems.length}{" "}
          {arrProblems.length === 1 ? "item" : "items"}{" "}
          directly through Plex because no verified {arrLabel}{" "}
          destination is available. These items may be downloaded again if they
          remain monitored.
        </PlexFallbackAcknowledgement>
      )}

      <DeletionDialogFooter
        cancelButtonRef={cancelButtonRef}
        pending={pending}
        confirmDisabled={confirmDisabled}
        confirmLabel="Delete permanently"
        onCancel={cancel}
        onConfirm={() =>
          onConfirm({
            coordinatedRatingKeys: deleteFromArr ? coordinatedRatingKeys : [],
            cleanupDownloads: deleteFromArr && cleanupDownloads,
          })}
      />
    </DeletionModalShell>
  );
}
