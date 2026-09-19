import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Trash2 } from "lucide-react";
import type { DeletionActivityItem } from "@shared/types";
import { api } from "../../lib/api.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import { formatRelativeTime } from "../../lib/format.ts";
import { deletionOperationTitle } from "../../routes/-deletionOperationState.ts";

export function deletionActivityStatus(operation: DeletionActivityItem): string {
  return operation.waitingForServiceVerification
    ? "Waiting for service verification"
    : deletionOperationTitle(operation.status);
}

export function DeletionActivity() {
  const [offset, setOffset] = useState(0);
  const params = { limit: 20, offset };
  const query = useQuery({
    queryKey: queryKeys.deletionOperations.list({ activity: true, ...params }),
    queryFn: () => api.deletionOperations.activity(params),
    // Also poll an empty/terminal list: another tab may accept or recheck work.
    refetchInterval: 5_000,
    refetchOnMount: "always",
  });
  return (
    <section className="space-y-3" aria-labelledby="deletion-activity-title">
      <div>
        <h2 id="deletion-activity-title" className="text-lg font-semibold">Deletion operations</h2>
        <p className="text-sm text-base-content/55">
          Active work first, followed by operations needing attention and recent outcomes. Open
          details to review service results and recovery options.
        </p>
      </div>
      {query.isLoading && <span className="loading loading-spinner loading-sm" />}
      {query.isError && (
        <div className="alert alert-error" role="alert">
          <AlertCircle className="size-4" />
          <span>Failed to load deletion operations</span>
        </div>
      )}
      {query.data && query.data.operations.length === 0 && (
        <p className="text-sm text-base-content/55">No deletion operations on this page.</p>
      )}
      {!!query.data?.operations.length && (
        <div className="workspace-surface divide-y divide-base-300">
          {query.data.operations.map((operation) => (
            <Link
              key={operation.id}
              to="/deletion-operations/$id"
              params={{ id: operation.id }}
              className="polished-row flex items-center gap-3 px-4 py-3.5 focus-visible:outline-2 focus-visible:outline-primary"
            >
              <Trash2 className="size-4 shrink-0 text-warning" />
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">
                  {operation.titles.join(", ") || "Deletion operation"}
                </p>
                <p
                  className={`text-sm ${
                    operation.status === "needs_attention"
                      ? "text-error"
                      : operation.status === "completed_with_warning"
                      ? "text-warning"
                      : "text-base-content/70"
                  }`}
                >
                  {deletionActivityStatus(operation)} · {operation.targetCount} item(s)
                </p>
              </div>
              <div className="shrink-0 text-right">
                <span className="text-sm text-primary">Open details</span>
                <p
                  className="text-xs text-base-content/40"
                  title={new Date(operation.createdAt * 1000).toLocaleString()}
                >
                  {formatRelativeTime(operation.createdAt)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
      {(offset > 0 || query.data?.hasMore) && (
        <div className="flex justify-center gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={offset === 0 || query.isFetching}
            onClick={() => setOffset(Math.max(0, offset - params.limit))}
          >
            Previous operations
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!query.data?.hasMore || query.isFetching}
            onClick={() => setOffset(offset + params.limit)}
          >
            More operations
          </button>
        </div>
      )}
    </section>
  );
}
