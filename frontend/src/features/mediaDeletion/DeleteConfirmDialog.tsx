import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Copy,
  Trash2,
} from "lucide-react";
import type { StaleItem } from "../../lib/api";
import { api } from "../../lib/api";
import { formatKilobytes } from "../../lib/format";
import {
  DestinationOptions,
  PlannedServiceIcons,
  PreviewStatus,
} from "./DeletionPlanSummary";
import { DeletionTree } from "./DeletionTree";
import { arrDestinationState } from "./deletionPreviewState";
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
  items: StaleItem[];
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
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const ratingKeys = useMemo(
    () => items.map((item) => item.ratingKey),
    [items],
  );
  const preview = useQuery({
    queryKey: ["download-cleanup-preview", libraryKey, ratingKeys],
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
  const orphanFiles = [...new Map(
    cleanupEligibleItems.flatMap((item) => item.orphanFiles).map((
      file,
    ) => [file.path, file]),
  ).values()];
  const cleanupEligibleCount = cleanupEligibleItems.length;
  const coordinatedRatingKeys = preview.data?.coordinatedConfigured
    ? preview.data.items.filter((item) => item.arrStatus === "resolved").map((
      item,
    ) => item.ratingKey)
    : [];
  const arrDestination = arrDestinationState(preview.data);
  const arrProblems = arrDestination.problems;
  const cleanupVerificationErrors =
    preview.data?.items.filter((item) =>
      item.arrStatus === "resolved" && item.status === "error"
    ) ?? [];
  const arrEntries =
    preview.data?.items.flatMap((previewItem) =>
      previewItem.arrStatus === "resolved"
        ? previewItem.arrTargets.map((target) => ({
          ratingKey: previewItem.ratingKey,
          target,
        }))
        : []
    ) ?? [];
  const arrService = items[0]?.type === "show" ? "sonarr" : "radarr";
  const arrLabel = arrService === "sonarr" ? "Sonarr" : "Radarr";
  const unmanagedSources =
    preview.data?.items.flatMap((previewItem) =>
      previewItem.sources.filter(
        (source) => source.verification === "unverified",
      ).map((source) => ({ ratingKey: previewItem.ratingKey, source }))
    ) ?? [];
  const retainedPaths = [...new Map(
    (preview.data?.items ?? []).flatMap((item) => item.retainedPaths).map((
      path,
    ) => [path.path, path]),
  ).values()];
  const arrOptionVisible = arrDestination.visible;
  const cleanupOptionVisible = arrOptionVisible &&
    (cleanupEligibleCount > 0 || cleanupVerificationErrors.length > 0);
  const cleanupUsesQbittorrent = downloadJobs.length > 0;
  useEffect(() => {
    setDeleteFromArr(true);
    setCleanupDownloads(false);
  }, [libraryKey, ratingKeys.join("|")]);
  useEffect(() => {
    if (preview.data && coordinatedRatingKeys.length === 0) {
      setDeleteFromArr(false);
    }
  }, [coordinatedRatingKeys.length, preview.data]);
  useEffect(() => {
    if (cleanupEligibleCount === 0) setCleanupDownloads(false);
  }, [cleanupEligibleCount]);
  useLayoutEffect(() => {
    if (dialogRef.current?.open) {
      cancelButtonRef.current?.focus({ preventScroll: true });
    }
  }, [dialogRef, items]);
  const cancel = () => {
    setDeleteFromArr(preview.data?.coordinatedConfigured ?? true);
    setCleanupDownloads(false);
    onCancel();
  };
  const totalSize = items.reduce((sum, i) => sum + (i.fileSize ?? 0), 0);
  // Deleting here removes every synced Media version, not just one redundant copy.
  // Movies carry an exact version count; shows only carry an existence flag because
  // episode media versions are not rolled up per show. Keep both signals compact so a
  // page-sized selection remains scannable.
  const hasMultiVersionItems = items.some(
    (i) => (i.versions?.length ?? 0) >= 2 || i.hasDuplicateEpisodes === true,
  );

  return (
    <dialog ref={dialogRef} className="modal" onClose={cancel}>
      <div className="modal-box polished-modal max-w-2xl">
        <h3 className="font-bold text-lg flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-error" /> Delete {items.length}
          {" "}
          item
          {items.length === 1 ? "" : "s"}?
        </h3>
        <p className="py-2 text-sm text-base-content/70">
          <span className="font-semibold text-base-content">
            {formatKilobytes(totalSize)}
          </span>{" "}
          will be permanently removed. This cannot be undone.
        </p>
        <ul className="mt-3 max-h-56 overflow-y-auto text-sm py-1 divide-y divide-base-300/50 rounded-lg border border-base-300 bg-base-200/40">
          {items.map((item) => {
            const versions = item.versions ?? [];
            const isMultiVersion = versions.length >= 2;
            const previewItem = previewByRatingKey.get(item.ratingKey);
            return (
              <li key={item.ratingKey} className="px-3 py-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate min-w-0 flex-1 flex items-center gap-1.5">
                    <span className="truncate">{item.title}</span>
                    {isMultiVersion && (
                      <span className="badge badge-warning badge-xs shrink-0">
                        {versions.length} versions
                      </span>
                    )}
                    {!isMultiVersion && item.hasDuplicateEpisodes && (
                      <Copy
                        className="w-3 h-3 text-warning shrink-0"
                        aria-label="Has duplicate episodes"
                      />
                    )}
                  </span>
                  <PlannedServiceIcons
                    deleteFromArr={deleteFromArr}
                    arrService={arrService}
                    arrStatus={previewItem?.arrStatus}
                    arrReason={previewItem?.arrReason}
                    arrTargets={previewItem?.arrStatus === "resolved"
                      ? previewItem.arrTargets
                      : []}
                    downloadJobCount={cleanupDownloads &&
                        previewItem?.status === "resolved"
                      ? previewItem.downloadJobs.length
                      : 0}
                    hardlinkFileCount={cleanupDownloads &&
                        previewItem?.status === "resolved"
                      ? previewItem.orphanFiles.length
                      : 0}
                    downloadCleanupResuming={Boolean(
                      cleanupDownloads && previewItem?.status === "resolved" &&
                        previewItem.downloadJobs.length === 0 &&
                        previewItem.orphanFiles.length === 0,
                    )}
                    cleanupDownloads={cleanupDownloads}
                    cleanupStatus={previewItem?.status}
                    cleanupReason={previewItem?.reason}
                  />
                  <span className="text-base-content/50 font-mono text-xs shrink-0">
                    {item.fileSize != null
                      ? formatKilobytes(item.fileSize)
                      : "—"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
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
            arrService={arrService}
            arrLabel={arrLabel}
            arrVisible={arrOptionVisible}
            arrWarning={arrProblems.length > 0}
            arrInfo={arrProblems[0]?.arrReason ??
              `Deletes the managed title and its files through ${arrLabel}.`}
            deleteFromArr={deleteFromArr}
            arrDisabled={pending || preview.isLoading ||
              coordinatedRatingKeys.length === 0}
            onArrChange={(checked) => {
              setDeleteFromArr(checked);
              if (!checked) setCleanupDownloads(false);
            }}
            cleanupVisible={cleanupOptionVisible}
            cleanupUsesQbittorrent={cleanupUsesQbittorrent}
            cleanupDownloads={cleanupDownloads}
            cleanupWarning={cleanupVerificationErrors.length > 0}
            cleanupInfo={cleanupVerificationErrors[0]?.reason ??
              (cleanupUsesQbittorrent
                ? "Removes verified qBittorrent jobs and asks qBittorrent to delete their downloaded files. Verified orphan hardlinks are also removed."
                : "Removes downloaded files whose hardlink identity has been verified safely.")}
            cleanupDisabled={pending || preview.isLoading || !deleteFromArr ||
              cleanupEligibleCount === 0}
            onCleanupChange={setCleanupDownloads}
          />
        )}

        <PreviewStatus
          loading={preview.isLoading}
          error={preview.isError ? preview.error.message : null}
          arrProblems={preview.data?.coordinatedConfigured
            ? arrProblems.map((problem) => ({
              title: items.find((item) => item.ratingKey === problem.ratingKey)
                ?.title ?? problem.ratingKey,
              reason: problem.arrReason ??
                "managed deletion could not be verified",
            }))
            : []}
          cleanupProblems={cleanupVerificationErrors.map((problem) => ({
            title: items.find((item) => item.ratingKey === problem.ratingKey)
              ?.title ?? problem.ratingKey,
            reason: problem.reason ??
              "downloaded-file cleanup could not be verified",
          }))}
        />

        <DeletionTree
          items={items}
          plexPreviews={previewByRatingKey}
          deleteFromArr={deleteFromArr}
          arrEntries={arrEntries}
          downloadJobs={downloadJobs}
          orphanFiles={orphanFiles}
          cleanupDownloads={cleanupDownloads}
          unmanagedSources={unmanagedSources}
          retainedPaths={retainedPaths}
          loading={preview.isLoading}
        />
        <div className="modal-action mt-3">
          <button
            ref={cancelButtonRef}
            type="button"
            className="btn btn-sm"
            onClick={cancel}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-error gap-2"
            onClick={() =>
              onConfirm({
                coordinatedRatingKeys: deleteFromArr
                  ? coordinatedRatingKeys
                  : [],
                cleanupDownloads: deleteFromArr && cleanupDownloads,
              })}
            disabled={pending || (deleteFromArr && preview.isLoading)}
          >
            {pending
              ? <span className="loading loading-spinner loading-xs" />
              : <Trash2 className="w-4 h-4" />}
            Delete permanently
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit" disabled={pending}>
          close
        </button>
      </form>
    </dialog>
  );
}
