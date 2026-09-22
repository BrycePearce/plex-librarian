import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { v4 as uuidv4 } from "uuid";
import type {
  ServiceDeletionPreview,
  ServiceDeletionRequest,
  ServiceDeletionSelection,
} from "../../../../shared/serviceOwnedDeletion.ts";
import { api, ApiError, deletionOperationIdFromError } from "../../lib/api.ts";
import {
  DeletionDialogFooter,
  DeletionModalShell,
  DeletionPreviewStatus,
  useDeletionDialogCancelFocus,
} from "./DeletionDialog.tsx";
import { formatKilobytes } from "../../lib/format.ts";
import { DestinationOptions } from "./DeletionPlanSummary.tsx";
import type { HistoricalDownloadPreview } from "../../../../shared/historicalDownloads.ts";
import {
  type DeletionSelectionDetails,
  deletionServiceNames,
  detectedDestinations,
  ServiceDeletionPreviewList,
  ServiceDeletionWarnings,
} from "./ServiceDeletionPreviewList.tsx";

export interface ServiceOwnedDeletionDialogProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  libraryKey: string;
  targets: ServiceDeletionSelection[];
  selectionDetails?: DeletionSelectionDetails[];
  onCreated: (operationId: string) => void;
  onCancel: () => void;
  embedded?: boolean;
  hideIntro?: boolean;
  title?: string;
  quickCleanupThresholdDays?: number;
  renderPreview?: (
    preview: ServiceDeletionPreview | undefined,
    state: { loading: boolean; error: string | undefined; historical?: HistoricalDownloadPreview },
  ) => ReactNode;
  previewDelayMs?: number;
  focusCancel?: boolean;
  confirmLabel?: ReactNode;
  selectionDisabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
}

/** Each selection owns fresh optional consent and an immutable retry request. */
export function ServiceOwnedDeletionDialog(props: ServiceOwnedDeletionDialogProps) {
  const selectionKey = JSON.stringify([
    props.libraryKey,
    props.targets,
    props.quickCleanupThresholdDays,
  ]);
  return <SelectionDialog key={selectionKey} {...props} />;
}

function SelectionDialog({
  dialogRef,
  libraryKey,
  targets,
  selectionDetails = [],
  onCreated,
  onCancel,
  embedded,
  hideIntro,
  title,
  quickCleanupThresholdDays,
  onPendingChange,
  renderPreview,
  confirmLabel,
  previewDelayMs = 0,
  focusCancel = true,
  selectionDisabled = false,
}: ServiceOwnedDeletionDialogProps) {
  const cancelButtonRef = useDeletionDialogCancelFocus(dialogRef, libraryKey, focusCancel);
  const [arrSelected, setArrSelected] = useState(false);
  const [qbSelected, setQbSelected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [inventory, setPreview] = useState<ServiceDeletionPreview>();
  const preview = inventory ? selectPreviewServices(inventory, arrSelected, qbSelected) : undefined;
  const displayPreview = preview;
  const historical = arrSelected ? inventory?.historical : undefined;
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<ServiceDeletionRequest | undefined>(undefined);
  const submissionWasUncertain = useRef(false);
  const submissionLocked = pending || !!request.current;
  useEffect(() => {
    onPendingChange?.(submissionLocked);
    return () => onPendingChange?.(false);
  }, [submissionLocked, onPendingChange]);
  // The outer component remounts on target changes; this stable copy avoids
  // preview requests from parent renders that merely recreate the targets array.
  const [selection] = useState(() => targets.map((target) => ({ ...target })));
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (selection.length === 0) {
      setLoading(false);
      setPreview(undefined);
      return;
    }
    setLoading(true);
    setPreview(undefined);
    setError(undefined);
    const loadPreview = () => {
      api.serviceDeletions.preview({
        libraryKey,
        targets: selection,
        arrSelected: false,
        qbSelected: false,
        quickCleanupThresholdDays,
      }, controller.signal)
        .then((result) => {
          if (active) {
            setPreview(result);
          }
        })
        .catch(() => {
          if (active) {
            setError("The current service inventory could not be read. Refresh to try again.");
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };
    const timer = previewDelayMs > 0 ? setTimeout(loadPreview, previewDelayMs) : undefined;
    if (timer === undefined) loadPreview();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    libraryKey,
    selection,
    revision,
    quickCleanupThresholdDays,
    previewDelayMs,
  ]);

  function changeDestination(service: "arr" | "qb", checked: boolean) {
    if (pending || request.current) return;
    if (service === "arr") setArrSelected(checked);
    else setQbSelected(checked);
  }

  function refresh() {
    if (pending || request.current) return;
    // A refresh can discover new targets. Ask for optional consent again.
    setArrSelected(false);
    setQbSelected(false);
    setPreview(undefined);
    setLoading(true);
    setRevision((value) => value + 1);
  }

  async function submit() {
    if (pending || (!request.current && (selectionDisabled || loading || !preview?.canConfirm))) {
      return;
    }
    request.current ??= {
      libraryKey,
      targets: selection,
      arrSelected,
      qbSelected,
      clientRequestId: uuidv4(),
      previewFingerprint: preview!.fingerprint,
      consentToken: preview!.consentToken,
      quickCleanupThresholdDays,
      ...(arrSelected && historical?.candidates.length
        ? {
          historicalCleanup: {
            fingerprint: historical.fingerprint,
            candidateIds: historical.candidates.map((c) => c.id),
          },
        }
        : {}),
    };
    setPending(true);
    setError(undefined);
    try {
      const result = await api.serviceDeletions.create(request.current);
      onCreated(result.operationId);
    } catch (failure) {
      const operationId = deletionOperationIdFromError(failure);
      if (operationId) {
        onCreated(operationId);
      } else if (
        !submissionWasUncertain.current && failure instanceof ApiError &&
        [400, 409, 422].includes(failure.status)
      ) {
        request.current = undefined;
        setPreview(undefined);
        setArrSelected(false);
        setQbSelected(false);
        setError(
          "The request was not accepted. Refresh the preview and review current service decisions again.",
        );
      } else {
        // A later rejection cannot disprove acceptance of an earlier request whose
        // response was lost. Keep its identity until that operation is reconciled.
        submissionWasUncertain.current = true;
        setError(
          "The submission outcome is unknown. Retry this same request to check or create the operation without submitting a second deletion.",
        );
      }
    } finally {
      setPending(false);
    }
  }

  function cancel() {
    // Losing this request after an ambiguous response could submit a second
    // operation when the user reopens the review. Reconcile the same ID first.
    if (!pending && !request.current) onCancel();
  }

  const destinations = detectedDestinations(displayPreview);
  const details = selection.map((target) =>
    selectionDetails.find((detail) =>
      detail.ratingKey === target.ratingKey && detail.mediaId === target.mediaId
    ) ?? { ...target, title: "Selected item", fileSize: null }
  );
  const sizes = (displayPreview?.targets ?? details).map((target) => target.fileSize);
  const knownSize = sizes.reduce<number>((total, size) => total + (size ?? 0), 0);
  const sizeLabel = sizes.some((size) => size == null)
    ? sizes.some((size) => size != null)
      ? `${formatKilobytes(knownSize)} + unknown size`
      : "Unknown size"
    : formatKilobytes(knownSize);
  const arrNames = destinations.filter((service) => service !== "qb")
    .map((service) => deletionServiceNames[service]).join(" / ");

  return (
    <DeletionModalShell
      dialogRef={dialogRef}
      pending={submissionLocked}
      embedded={embedded}
      hideIntro={hideIntro}
      title={title ?? `Delete ${selection.length} item${selection.length === 1 ? "" : "s"}?`}
      summary={
        <>
          <span className="font-semibold text-base-content">
            {sizeLabel} selected
          </span>
          {"\u00a0"}
          This cannot be undone.
        </>
      }
      onClose={cancel}
    >
      {renderPreview
        ? renderPreview(displayPreview, {
          loading,
          error,
          historical: loading || !arrSelected ? undefined : historical,
        })
        : (
          <ServiceDeletionPreviewList
            preview={displayPreview}
            selectionDetails={details}
            loading={loading}
            historical={loading || !arrSelected ? undefined : historical}
            collapsible={!embedded}
            showWarnings={false}
          />
        )}
      {displayPreview && <ServiceDeletionWarnings preview={displayPreview} />}
      <DestinationOptions
        loading={loading}
        options={[
          ...(arrNames
            ? [{
              id: "arr" as const,
              service: destinations.includes("sonarr") ? "sonarr" as const : "radarr" as const,
              label: "Delete from " + arrNames,
              info: destinations.includes("sonarr")
                ? "Delete current matched media through Sonarr, including eligible history-linked download files shown in the preview. Files needed by a service you keep are retained."
                : "Delete current matched media through the selected service. Files needed by a service you keep are retained.",
              checked: arrSelected,
              disabled: loading || submissionLocked || !preview?.arrConfigured,
              warning: false,
              onChange: (checked: boolean) => changeDestination("arr", checked),
            }]
            : []),
          ...(destinations.includes("qb")
            ? [{
              id: "cleanup" as const,
              service: "qbittorrent" as const,
              label: "Delete from qBittorrent",
              info:
                "Delete matching torrents and their files. Unselected media and shared downloads are protected.",
              checked: qbSelected,
              disabled: loading || submissionLocked || !preview?.qbConfigured,
              warning: false,
              onChange: (checked: boolean) => changeDestination("qb", checked),
            }]
            : []),
        ]}
      />
      <DeletionPreviewStatus
        error={error ?? null}
        onRetry={request.current ? undefined : refresh}
        retrying={loading}
      />
      <DeletionDialogFooter
        cancelButtonRef={cancelButtonRef}
        pending={submissionLocked}
        preparing={loading}
        confirmDisabled={pending ||
          (!request.current && (selectionDisabled || loading || !preview?.canConfirm))}
        confirmLabel={pending
          ? "Submitting…"
          : request.current
          ? "Retry same request"
          : confirmLabel ?? "Confirm deletion"}
        onCancel={cancel}
        onConfirm={() => void submit()}
      />
    </DeletionModalShell>
  );
}

/** Checkbox changes only select previously discovered effects; no service reads. */
export function selectPreviewServices(
  preview: ServiceDeletionPreview,
  arr: boolean,
  qb: boolean,
): ServiceDeletionPreview {
  return {
    ...preview,
    targets: preview.targets.map((target) => ({
      ...target,
      decisions: target.decisions.map((decision) => {
        const requested = decision.service === "plex" ||
          (decision.service === "qb" ? qb && decision.matchedToSelection === true : arr);
        return {
          ...decision,
          requested,
          state: !requested && decision.presence !== "unknown"
            ? "kept"
            : preview.discovery && decision.presence === "current"
            ? "delete_candidate"
            : decision.state,
          reason: !requested && decision.presence !== "unknown"
            ? "This optional service target was not selected"
            : preview.discovery
            ? "Intended action; eligibility is verified after confirmation"
            : decision.reason,
        };
      }),
    })),
  };
}
