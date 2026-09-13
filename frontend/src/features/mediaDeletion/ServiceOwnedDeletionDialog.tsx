import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { v4 as uuidv4 } from "uuid";
import type {
  ServiceDeletionPreview,
  ServiceDeletionRequest,
  ServiceDeletionSelection,
} from "../../../../shared/serviceOwnedDeletion.ts";
import { api, ApiError, deletionOperationIdFromError } from "../../lib/api.ts";
import { DeletionModalShell } from "./DeletionDialog.tsx";
import {
  deletionServiceNames,
  detectedDestinations,
  ServiceDeletionPreviewList,
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
  title = "Review deletion",
  quickCleanupThresholdDays,
  onPendingChange,
}: ServiceOwnedDeletionDialogProps) {
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
    if (pending || (!request.current && (loading || !preview?.canConfirm))) return;
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
      title={title}
      summary="Remove the selected media from Plex. Choose any connected services to clean up as well. Files needed by a service you keep will be retained."
      onClose={cancel}
    >
      {displayPreview && <ServiceDeletionPreviewList preview={displayPreview} />}
      <div className="my-3 flex flex-wrap gap-4">
        {arrNames && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={arrSelected}
              disabled={loading || pending || !!request.current || !preview?.arrConfigured}
              onChange={(event) => changeDestination("arr", event.target.checked)}
            />
            Delete from {arrNames}
          </label>
        )}
        {destinations.includes("qb") && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={qbSelected}
              disabled={loading || pending || !!request.current || !preview?.qbConfigured}
              onChange={(event) => changeDestination("qb", event.target.checked)}
            />
            Delete qBittorrent jobs and data
          </label>
        )}
      </div>
      {destinations.length > 0 && displayPreview && displayPreview.targets.length > 1 &&
        (
          <p className="text-xs text-base-content/60">
            Optional services apply only to matching items in this selection.
          </p>
        )}
      {loading && <p role="status">Reading current service targets…</p>}
      {error && <p role="alert" className="my-3 text-sm text-error">{error}</p>}
      {displayPreview?.targets.some((target) => target.fileSize != null) &&
        (
          <p className="mt-2 text-xs text-base-content/50">
            Sizes describe selected media, not measured disk space reclaimed.
          </p>
        )}
      <div className="modal-action">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={submissionLocked}
          onClick={cancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={loading || pending || !!request.current}
          onClick={refresh}
        >
          Refresh
        </button>
        <button
          type="button"
          className="btn btn-error"
          disabled={pending || (!request.current && (loading || !preview?.canConfirm))}
          onClick={() => void submit()}
        >
          {pending ? "Submitting…" : request.current ? "Retry same request" : "Confirm deletion"}
        </button>
      </div>
    </DeletionModalShell>
  );
}
