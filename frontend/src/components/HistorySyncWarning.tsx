import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { SyncDataNotice } from "./SyncDataNotice.tsx";
import "./SyncStatusNotice.css";

// Callers that track a live per-library sync signal (`isSyncing`) use the same shared
// in-progress notice as Users and Duplicates, only falling through to the warning variant
// once syncing has settled (or once `isSyncStatusLoading` resolves, to avoid flashing the
// warning for one frame before sync status is known). Callers with no such signal keep the
// unconditional warning behavior.
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
    return <SyncDataNotice>{syncingMessage}</SyncDataNotice>;
  }

  if (isSyncStatusLoading) return null;

  return (
    <div className="alert alert-warning banner-beam banner-beam-warning">
      <AlertTriangle className="w-4 h-4" />
      <span>{warningMessage}</span>
    </div>
  );
}
