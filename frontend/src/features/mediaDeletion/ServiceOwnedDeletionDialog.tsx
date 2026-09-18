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
import {
  deletionServiceNames,
  detectedDestinations,
  ServiceDeletionPreviewList,
  ServiceDeletionWarnings,
} from "./ServiceDeletionPreviewList.tsx";

export interface ServiceOwnedDeletionDialogProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  libraryKey: string;
  targets: ServiceDeletionSelection[];
  onCreated: (operationId: string) => void;
  onCancel: () => void;
  embedded?: boolean;
  hideIntro?: boolean;
  title?: string;
  quickCleanupThresholdDays?: number;
  renderPreview?: (preview: ServiceDeletionPreview | undefined) => ReactNode;
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
  onCreated,
  onCancel,
  embedded,
  hideIntro,
  title,
  quickCleanupThresholdDays,
  onPendingChange,
  renderPreview,
  confirmLabel,
  selectionDisabled = false,
}: ServiceOwnedDeletionDialogProps) {
  const cancelButtonRef = useDeletionDialogCancelFocus(dialogRef, libraryKey);
  const [arrSelected, setArrSelected] = useState(false);
  const [qbSelected, setQbSelected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<ServiceDeletionPreview>();
  const [displayPreview, setDisplayPreview] = useState<ServiceDeletionPreview>();
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
    if (selection.length === 0) {
      setLoading(false);
      setPreview(undefined);
      setDisplayPreview(undefined);
      return;
    }
    setLoading(true);
    setPreview(undefined);
    setError(undefined);
    api.serviceDeletions.preview({
      libraryKey,
      targets: selection,
      arrSelected,
      qbSelected,
      quickCleanupThresholdDays,
    })
      .then((result) => {
        if (active) {
          setPreview(result);
          setDisplayPreview(result);
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
    return () => {
      active = false;
    };
  }, [libraryKey, selection, arrSelected, qbSelected, revision, quickCleanupThresholdDays]);

  function changeDestination(service: "arr" | "qb", checked: boolean) {
    if (pending || request.current) return;
    setPreview(undefined);
    setLoading(true);
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
      quickCleanupThresholdDays,
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
            {formatKilobytes(
              displayPreview?.targets.reduce(
                (total, target) => total + (target.fileSize ?? 0),
                0,
              ) ?? 0,
            )} selected
          </span>
          {"\u00a0"}
          This cannot be undone.
        </>
      }
      onClose={cancel}
    >
      {renderPreview ? renderPreview(displayPreview) : displayPreview && (
        <ServiceDeletionPreviewList
          preview={displayPreview}
          collapsible={!embedded}
          showWarnings={false}
        />
      )}
      {displayPreview && <ServiceDeletionWarnings preview={displayPreview} />}
      <DestinationOptions
        options={[
          ...(arrNames
            ? [{
              id: "arr" as const,
              service: destinations.includes("sonarr") ? "sonarr" as const : "radarr" as const,
              label: "Delete from " + arrNames,
              info:
                "Delete current matched media through the selected service. Files needed by a service you keep are retained.",
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
