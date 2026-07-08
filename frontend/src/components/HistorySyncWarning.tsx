import { AlertTriangle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

// Callers that track a live per-library sync signal (`isSyncing`) get a softer "in
// progress" info variant while a sync is actually running, only falling through to the
// scarier warning variant once it isn't (or once `isSyncStatusLoading` resolves, to
// avoid flashing the warning for one frame before sync status is known). Callers with no
// such signal (both omitted) just get the unconditional warning — same as before this was
// a shared component.
export function HistorySyncWarning({
  historySyncedAt,
  isSyncing,
  isSyncStatusLoading,
  syncingMessage,
  warningMessage,
}: {
  historySyncedAt: number | null;
  isSyncing?: boolean;
  isSyncStatusLoading?: boolean;
  syncingMessage?: ReactNode;
  warningMessage: ReactNode;
}) {
  if (historySyncedAt !== null) return null;

  if (isSyncing && syncingMessage) {
    return (
      <div className="alert alert-info alert-soft py-2 text-sm banner-beam banner-beam-info">
        <RefreshCw className="w-4 h-4 animate-spin" />
        <span>{syncingMessage}</span>
      </div>
    );
  }

  if (isSyncStatusLoading) return null;

  return (
    <div className="alert alert-warning banner-beam banner-beam-warning">
      <AlertTriangle className="w-4 h-4" />
      <span>{warningMessage}</span>
    </div>
  );
}
