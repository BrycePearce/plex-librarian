import type { RefObject } from "react";
import { XCircle } from "lucide-react";
import "../../components/dataSurfaces.css";

export function DismissRecoveryDialog({
  dialogRef,
  title,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  title: string;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onClose={onClose}
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      <div className="modal-box polished-modal max-w-md">
        <h3 className="flex items-center gap-2 text-lg font-bold">
          <XCircle className="size-5 text-warning" />
          Dismiss this problem?
        </h3>
        <p className="mt-2 text-sm font-medium">{title}</p>
        <p className="mt-1 text-sm text-base-content/65">
          This releases the recovery lock. The original error remains in the operation history.
        </p>
        {error != null && (
          <p className="mt-3 text-sm text-error" role="alert">
            {error instanceof Error ? error.message : "Could not dismiss this problem"}
          </p>
        )}
        <div className="modal-action mt-4">
          <button type="button" className="btn btn-sm" disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-warning btn-sm"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending && <span className="loading loading-spinner loading-xs" />}
            Dismiss
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
