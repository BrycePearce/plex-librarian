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
import { ServiceActionDecisions } from "./ServiceActionDecisions.tsx";

export interface ServiceOwnedDeletionDialogProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  libraryKey: string;
  targets: ServiceDeletionSelection[];
  onCreated: (operationId: string) => void;
  onCancel: () => void;
  embedded?: boolean;
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
  title = "Review deletion",
  quickCleanupThresholdDays,
  onPendingChange,
}: ServiceOwnedDeletionDialogProps) {
  const [arrSelected, setArrSelected] = useState(false);
  const [qbSelected, setQbSelected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<ServiceDeletionPreview>();
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
        if (active) setPreview(result);
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

  return (
    <DeletionModalShell
      dialogRef={dialogRef}
      pending={submissionLocked}
      embedded={embedded}
      title={title}
      summary="Plex deletion is requested by default. A retained qBittorrent entry can keep overlapping service actions. Selected media size is not measured reclaimed space."
      onClose={cancel}
    >
      <div className="my-3 flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={arrSelected}
            disabled={loading || pending || !!request.current || !preview?.arrConfigured}
            onChange={(event) => changeDestination("arr", event.target.checked)}
          />
          Delete from Sonarr / Radarr
        </label>
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
      </div>
      {loading && <p role="status">Reading current service targets…</p>}
      {error && <p role="alert" className="my-3 text-sm text-error">{error}</p>}
      <div className="max-h-[50vh] space-y-4 overflow-y-auto">
        {preview?.targets.map((target) => (
          <section key={`${target.ratingKey}:${target.mediaId ?? "whole"}`}>
            <h4 className="mb-2 font-semibold">{target.title}</h4>
            <ServiceActionDecisions actions={target.decisions} />
          </section>
        ))}
      </div>
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
          {pending ? "Submitting…" : request.current ? "Retry same request" : "Confirm decisions"}
        </button>
      </div>
    </DeletionModalShell>
  );
}
