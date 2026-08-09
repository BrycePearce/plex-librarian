import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import "./SyncStatusNotice.css";

export function SyncDataNotice({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div
      className="alert alert-info alert-soft banner-beam banner-beam-info"
      role="status"
      aria-live="polite"
    >
      <RefreshCw className="w-4 h-4 animate-spin" />
      <div>
        <div className="font-medium">Sync in progress</div>
        <div className="text-sm opacity-80">{children}</div>
      </div>
    </div>
  );
}
