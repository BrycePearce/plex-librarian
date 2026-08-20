import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Sparkles, X } from "lucide-react";
import { QuickCleanupPanel } from "./QuickCleanupPanel.tsx";
import "../../features/quickCleanup/quickCleanup.css";

export function LibraryQuickCleanupAction({
  libraryKey,
  libraryItemCount,
  automaticThresholdDays,
  isSyncing,
  isSyncStatusLoading,
}: {
  libraryKey: string;
  libraryItemCount: number;
  automaticThresholdDays: number;
  isSyncing: boolean;
  isSyncStatusLoading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) dialogRef.current?.showModal();
  }, [open]);

  function close() {
    dialogRef.current?.close();
    setOpen(false);
    setReviewOpen(false);
    setReviewPending(false);
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-primary btn-sm quick-cleanup-launch"
        onClick={() => setOpen(true)}
      >
        <Sparkles className="quick-cleanup-launch-sparkle size-4" />
        Quick cleanup
      </button>

      {open && (
        <dialog
          ref={dialogRef}
          className="modal"
          onCancel={(event) => {
            if (reviewPending) event.preventDefault();
          }}
          onClose={() => {
            setOpen(false);
            setReviewOpen(false);
            setReviewPending(false);
          }}
        >
          <div className="modal-box smart-cleanup-modal max-w-4xl p-0">
            <header className="smart-cleanup-header">
              {reviewOpen
                ? (
                  <button
                    type="button"
                    className="smart-cleanup-header-icon"
                    aria-label="Back to cleanup recommendations"
                    disabled={reviewPending}
                    onClick={() => setReviewOpen(false)}
                  >
                    <ArrowLeft className="size-5" />
                  </button>
                )
                : (
                  <div className="smart-cleanup-header-icon">
                    <Sparkles className="size-5" />
                  </div>
                )}
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] opacity-55">
                  Storage intelligence
                </div>
                <h2 className="mt-1 text-xl font-semibold">Quick cleanup</h2>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-square ml-auto"
                aria-label="Close"
                disabled={reviewPending}
                onClick={close}
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="smart-cleanup-body">
              <QuickCleanupPanel
                libraryKey={libraryKey}
                libraryItemCount={libraryItemCount}
                automaticThresholdDays={automaticThresholdDays}
                isSyncing={isSyncing}
                isSyncStatusLoading={isSyncStatusLoading}
                dialogRef={dialogRef}
                reviewOpen={reviewOpen}
                onReviewOpenChange={setReviewOpen}
                onReviewPendingChange={setReviewPending}
                onClose={close}
              />
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button type="submit" disabled={reviewPending}>close</button>
          </form>
        </dialog>
      )}
    </>
  );
}
