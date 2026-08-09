import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { SyncDataNotice } from "./SyncDataNotice.tsx";
import "./SyncStatusNotice.css";

// Callers that track a live per-library sync signal (`isSyncing`) use the same shared
// in-progress notice as Users and Duplicates, only falling through to the warning variant
// once syncing has settled and the owning query is authoritative. Callers with no live
// sync or refresh signals keep the unconditional warning behavior.
export function HistorySyncWarning({
  historySyncedAt,
  isSyncing,
  isSyncStatusLoading,
  isDataRefreshing,
  syncingMessage,
  warningMessage,
}: {
  historySyncedAt: number | null;
  isSyncing?: boolean;
  isSyncStatusLoading?: boolean;
  isDataRefreshing?: boolean;
  syncingMessage?: ReactNode;
  warningMessage: ReactNode;
}) {
  if (historySyncedAt !== null) return null;

  if (isSyncing && syncingMessage) {
    return <SyncDataNotice>{syncingMessage}</SyncDataNotice>;
  }

  // Cached or placeholder query data may carry historySyncedAt: null from the middle
  // of a sync. Do not turn that transient value into a warning while the owning view is
  // fetching its authoritative response. A real incomplete-history result will render
  // the warning as soon as that request settles.
  if (isSyncStatusLoading || isDataRefreshing) return null;

  return (
    <div className="alert alert-warning banner-beam banner-beam-warning">
      <AlertTriangle className="w-4 h-4" />
      <span>{warningMessage}</span>
    </div>
  );
}
