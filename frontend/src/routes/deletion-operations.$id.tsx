import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { api } from "../lib/api";
import { formatKilobytes } from "../lib/format";
import { requireAuth } from "../lib/requireAuth";
import { ErrorAlert } from "../components/ErrorAlert";
import {
  activeDeletionStatuses,
  deletionOperationPollInterval,
  deletionOperationTitle,
} from "./-deletionOperationState";

export const Route = createFileRoute("/deletion-operations/$id")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: DeletionOperationPage,
});

function DeletionOperationPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const queryKey = ["deletion-operation", id] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => api.deletionOperations.get(id),
    refetchInterval: (state) =>
      deletionOperationPollInterval(state.state.data?.status),
  });
  const cancel = useMutation({
    mutationFn: () => api.deletionOperations.cancel(id),
    onSuccess: (data) => qc.setQueryData(queryKey, data),
  });
  const retry = useMutation({
    mutationFn: () => api.deletionOperations.retry(id),
    onSuccess: (data) => qc.setQueryData(queryKey, data),
  });

  if (query.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="loading loading-ring loading-lg text-primary" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <ErrorAlert
        message={query.error instanceof Error
          ? query.error.message
          : "Operation not found"}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const operation = query.data;
  const current =
    operation.targets.find((target) => target.status === "running") ??
      operation.targets.find((target) =>
        target.status === "waiting_retry" || target.status === "queued"
      );
  const done = operation.completedCount + operation.failedCount +
    operation.targets.filter((target) => target.status === "cancelled").length;
  const percent = operation.targetCount === 0
    ? 0
    : Math.round(done / operation.targetCount * 100);

  return (
    <div className="flex flex-col gap-6 max-w-4xl w-full mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-base-content/45">
            Deletion operation
          </p>
          <h1 className="text-3xl font-semibold mt-1">
            {deletionOperationTitle(operation.status)}
          </h1>
          <p className="text-sm text-base-content/55 mt-2">
            Operation {operation.id}
          </p>
        </div>
        <span className={`badge badge-lg ${statusBadge(operation.status)}`}>
          {operation.status.replace(/_/g, " ")}
        </span>
      </div>

      <section className="card bg-base-200 border border-base-300">
        <div className="card-body gap-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat
              label="Completed"
              value={`${operation.completedCount} / ${operation.targetCount}`}
            />
            <Stat label="Failed" value={String(operation.failedCount)} />
            <Stat
              label="Logical size removed"
              value={formatKilobytes(operation.logicalSizeRemoved)}
            />
            <Stat label="Progress" value={`${percent}%`} />
          </div>
          <progress
            className="progress progress-primary w-full"
            value={done}
            max={operation.targetCount}
          />
          {current && activeDeletionStatuses.has(operation.status) && (
            <div className="flex items-center gap-3 rounded-lg bg-base-100 px-4 py-3">
              {current.status === "waiting_retry"
                ? <Clock3 className="size-5 text-warning" />
                : (
                  <span className="loading loading-spinner loading-sm text-primary" />
                )}
              <div className="min-w-0">
                <p className="font-medium truncate">{current.title}</p>
                <p className="text-sm text-base-content/55">
                  {current.status === "waiting_retry"
                    ? "Waiting to retry"
                    : current.status === "running"
                    ? "Deleting"
                    : "Queued"}
                  {current.nextRetryAt
                    ? ` · retrying ${
                      new Date(current.nextRetryAt * 1000)
                        .toLocaleTimeString()
                    }`
                    : ""}
                </p>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {operation.targets.some((target) => target.status === "queued") && (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                <XCircle className="size-4" />
                Cancel queued targets
              </button>
            )}
            {operation.failedCount > 0 &&
              !activeDeletionStatuses.has(operation.status) && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={retry.isPending}
                onClick={() => retry.mutate()}
              >
                <RotateCcw className="size-4" />Retry failed targets
              </button>
            )}
            <Link to="/dashboard" className="btn btn-ghost btn-sm">
              Back to dashboard
            </Link>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Targets</h2>
        {operation.targets.map((target) => (
          <div
            key={target.id}
            className="flex items-start gap-3 rounded-lg border border-base-300 bg-base-100 px-4 py-3"
          >
            {target.status === "completed"
              ? <CheckCircle2 className="size-5 text-success mt-0.5" />
              : target.status === "needs_attention"
              ? <AlertTriangle className="size-5 text-error mt-0.5" />
              : target.status === "cancelled"
              ? <XCircle className="size-5 text-base-content/40 mt-0.5" />
              : <Clock3 className="size-5 text-info mt-0.5" />}
            <div className="min-w-0 flex-1">
              <div className="flex justify-between gap-3">
                <p className="font-medium truncate">{target.title}</p>
                <span className="text-xs uppercase text-base-content/45">
                  {target.status.replace(/_/g, " ")}
                </span>
              </div>
              <p className="text-sm text-base-content/50">
                {target.logicalSize != null
                  ? formatKilobytes(target.logicalSize)
                  : ""}
              </p>
              {target.error && (
                <p className="text-sm text-error mt-1">{target.error}</p>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-base-content/45">
        {label}
      </p>
      <p className="text-lg font-semibold mt-1">{value}</p>
    </div>
  );
}

function statusBadge(status: string): string {
  if (status === "completed") return "badge-success";
  if (status === "needs_attention") return "badge-warning";
  if (status === "cancelled") return "badge-ghost";
  return "badge-info";
}
