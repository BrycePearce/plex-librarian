import type { RefObject } from "react";
import { AlertTriangle, UserX } from "lucide-react";
import type { PlexUser } from "../../lib/api.ts";
import "../../components/dataSurfaces.css";

export function RemoveUserConfirmDialog({
  dialogRef,
  user,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  user: PlexUser | null;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <dialog ref={dialogRef} className="modal" onClose={onCancel}>
      <div className="modal-box polished-modal">
        <h3 className="font-bold text-lg flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-error" />
          Remove {user?.username}'s access?
        </h3>
        <p className="py-2 text-sm text-base-content/70">
          This revokes{" "}
          <span className="font-semibold text-base-content">{user?.username}</span>'s ability to see
          or stream from this server. This cannot be undone from here — you'll need to re-invite
          them through Plex to restore access.
        </p>
        {error != null && (
          <p className="text-error text-sm">
            {error instanceof Error ? error.message : "Remove failed"}
          </p>
        )}
        <div className="modal-action mt-3">
          <button
            type="button"
            className="btn btn-sm"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-error gap-2"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending
              ? <span className="loading loading-spinner loading-xs" />
              : <UserX className="w-4 h-4" />}
            Remove access
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
