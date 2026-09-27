import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { AlertCircle, ArrowRight, CheckCircle, Info } from "lucide-react";
import type { Library, SyncLog } from "../../lib/api.ts";
import { formatDuration } from "../../lib/format.ts";
import { SectionHeading } from "../../components/Workspace.tsx";
import { pageSectionVariants } from "./animation.ts";

export function RecentSyncs({ history, libraries }: { history: SyncLog[]; libraries: Library[] }) {
  return (
    <motion.section
      className="dashboard-panel sync-history-panel"
      variants={pageSectionVariants}
    >
      <div className="dashboard-panel-header">
        <SectionHeading
          eyebrow="Operations"
          title="Recent syncs"
          meta={
            <Link to="/activity" className="dashboard-panel-link">
              View activity <ArrowRight className="size-4" />
            </Link>
          }
        />
      </div>
      <div className="overflow-x-auto sync-history-table">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Status</th>
              <th>Library</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Items</th>
            </tr>
          </thead>
          <tbody>
            {history.slice(0, 3).map((s) => (
              <SyncRow
                key={s.id}
                sync={s}
                libraryTitle={s.libraryKey
                  ? (libraries.find(
                    (l) => l.key === s.libraryKey,
                  )?.title ?? s.libraryKey)
                  : null}
              />
            ))}
          </tbody>
        </table>
      </div>
    </motion.section>
  );
}

function SyncRow({
  sync,
  libraryTitle,
}: {
  sync: SyncLog;
  libraryTitle: string | null;
}) {
  return (
    <tr className="sync-history-row">
      <td>
        {sync.status === "pending" && (
          <span className="badge badge-info gap-1 min-w-22 justify-center leading-none">
            <span className="loading loading-spinner loading-xs" /> pending
          </span>
        )}
        {sync.status === "success" && (
          <span className="badge dashboard-success-badge gap-1 min-w-22 justify-center leading-none">
            <CheckCircle className="w-3 h-3" /> success
          </span>
        )}
        {sync.status === "error" && (
          <span className="inline-flex items-center gap-1.5">
            <span className="badge badge-error gap-1 min-w-22 justify-center leading-none">
              <AlertCircle className="w-3 h-3" /> error
            </span>
            <span title={sync.error ?? ""}>
              <Info className="w-4 h-4 text-error cursor-help" />
            </span>
          </span>
        )}
      </td>
      <td className="text-sm text-base-content/70">
        {libraryTitle ?? <span className="text-base-content/40">All libraries</span>}
      </td>
      <td className="text-sm text-base-content/70">
        {new Date(sync.startedAt * 1000).toLocaleString()}
      </td>
      <td className="text-sm text-base-content/70">
        {sync.finishedAt ? formatDuration(sync.finishedAt - sync.startedAt) : "—"}
      </td>
      <td className="text-sm font-mono">
        {(sync.itemsProcessed ?? 0).toLocaleString()}
      </td>
    </tr>
  );
}
