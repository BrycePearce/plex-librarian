import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock3, RotateCcw, XCircle } from "lucide-react";
import { api } from "../lib/api.ts";
import { formatKilobytes } from "../lib/format.ts";
import { requireAuth } from "../lib/requireAuth.ts";
import { queryKeys } from "../lib/queryKeys.ts";
import { ErrorAlert } from "../components/ErrorAlert.tsx";
import { RelocationWorkflowCard } from "../features/deletionOperations/RelocationWorkflowCard.tsx";
import {
  activeDeletionStatuses,
  deletionOperationPollInterval,
  deletionOperationTitle,
  nonSupersededCancelledCount,
  retryableRelocationSafeTargetCount,
} from "./-deletionOperationState.ts";

export const Route = createFileRoute("/deletion-operations/$id")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: DeletionOperationPage,
});

function DeletionOperationPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const queryKey = queryKeys.deletionOperations.detail(id);
  const query = useQuery({
    queryKey,
    queryFn: () => api.deletionOperations.get(id),
    refetchInterval: (state) => {
      if (
        state.state.data?.targets.some(
          (target) => target.relocationSyncBarrier && !target.relocationSyncBarrier.finishedAt,
        )
      ) {
        return 1_000;
      }
      return deletionOperationPollInterval(state.state.data?.status, state.state.data?.nextRetryAt);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.deletionOperations.cancel(id),
    onSuccess: (data) => qc.setQueryData(queryKey, data),
  });
  const retry = useMutation({
    mutationFn: (outcome: "needs_attention" | "warning") =>
      api.deletionOperations.retry(id, outcome),
    onSuccess: (data) => qc.setQueryData(queryKey, data),
  });
  const resolveHold = useMutation({
    mutationFn: () => api.deletionOperations.resolve(id),
    onSuccess: ({ operation }) => qc.setQueryData(queryKey, operation),
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
        message={query.error instanceof Error ? query.error.message : "Operation not found"}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const operation = query.data;
  const current = operation.targets.find((target) => target.status === "running") ??
    operation.targets.find(
      (target) => target.status === "waiting_retry" || target.status === "queued",
    );
  const retryableFailedCount = retryableRelocationSafeTargetCount(
    operation.targets.filter((target) => target.resolutionState !== "management_hold"),
    "needs_attention",
  );
  const retryableWarningCount = retryableRelocationSafeTargetCount(
    operation.targets,
    "completed_with_warning",
  );

  return (
    <div className="flex flex-col gap-6 max-w-4xl w-full mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-base-content/45">
            Deletion operation
          </p>
          <h1 className="text-3xl font-semibold mt-1">
            {operation.status === "completed_with_warning" && operation.removalConfirmedCount === 0
              ? "Arr removal completed; Plex removal was not confirmed"
              : deletionOperationTitle(operation.status)}
          </h1>
          <p className="text-sm text-base-content/55 mt-2">Operation {operation.id}</p>
        </div>
        <span className={`badge badge-lg ${statusBadge(operation.status)}`}>
          {operation.status.replace(/_/g, " ")}
        </span>
      </div>

      <section className="card bg-base-200 border border-base-300">
        <div className="card-body gap-5">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Stat
              label="Completed"
              value={`${operation.completedCount} / ${operation.targetCount}`}
            />
            <Stat label="Failed" value={String(operation.failedCount)} />
            <Stat label="Warning" value={String(operation.warningCount)} />
            <Stat label="Removed" value={String(operation.removalConfirmedCount)} />
            <Stat
              label="Updating Plex"
              value={String(
                operation.targets.filter(
                  (target) =>
                    target.phase === "plex_reconciliation" &&
                    activeDeletionStatuses.has(target.status),
                ).length,
              )}
            />
            <Stat
              label="Logical size removed"
              value={formatKilobytes(operation.logicalSizeRemoved)}
            />
            <Stat
              label="Cancelled"
              value={String(
                nonSupersededCancelledCount(operation.cancelledCount, operation.supersededCount),
              )}
            />
            <Stat label="Superseded" value={String(operation.supersededCount)} />
          </div>
          {current && activeDeletionStatuses.has(operation.status) && (
            <div className="flex items-center gap-3 rounded-lg bg-base-100 px-4 py-3">
              {current.status === "waiting_retry"
                ? <Clock3 className="size-5 text-warning" />
                : <span className="loading loading-spinner loading-sm text-primary" />}
              <div className="min-w-0">
                <p className="font-medium truncate">{current.title}</p>
                <p className="text-sm text-base-content/55">
                  {current.status === "waiting_retry"
                    ? current.phase === "plex_reconciliation"
                      ? "Updating Plex — waiting to retry"
                      : "Waiting to retry"
                    : current.status === "running"
                    ? current.phase === "plex_reconciliation" ? "Updating Plex" : "Deleting"
                    : "Queued"}
                  {current.nextRetryAt
                    ? ` · retrying ${new Date(current.nextRetryAt * 1000).toLocaleTimeString()}`
                    : ""}
                </p>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {operation.targets.some((target) => target.resolutionState === "management_hold") && (
              <button
                type="button"
                className="btn btn-warning btn-sm"
                disabled={resolveHold.isPending}
                onClick={() => resolveHold.mutate()}
              >
                <RotateCcw className="size-4" />
                Verify repaired Radarr state
              </button>
            )}
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
            {retryableFailedCount > 0 && !activeDeletionStatuses.has(operation.status) && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={retry.isPending}
                onClick={() => retry.mutate("needs_attention")}
              >
                <RotateCcw className="size-4" />
                Retry failed targets
              </button>
            )}
            {retryableWarningCount > 0 && !activeDeletionStatuses.has(operation.status) && (
              <button
                type="button"
                className="btn btn-warning btn-sm"
                disabled={retry.isPending}
                onClick={() => retry.mutate("warning")}
              >
                <RotateCcw className="size-4" />
                Retry Plex cleanup
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
          <details
            key={target.id}
            open={target.status !== "completed"}
            className="rounded-lg border border-base-300 bg-base-100"
          >
            <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3">
              {target.status === "completed"
                ? <CheckCircle2 className="size-5 text-success mt-0.5" />
                : target.status === "needs_attention"
                ? <AlertTriangle className="size-5 text-error mt-0.5" />
                : target.status === "completed_with_warning"
                ? <AlertTriangle className="size-5 text-warning mt-0.5" />
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
                  {target.logicalSize != null ? formatKilobytes(target.logicalSize) : ""}
                </p>
                {target.error && target.phase !== "plex_reconciliation" && (
                  <p className="text-sm text-error mt-1">{target.error}</p>
                )}
                {target.warning && <p className="text-sm text-warning mt-1">{target.warning}</p>}
                <p className="text-xs text-base-content/45 mt-2">
                  {phaseLabel(target.phase)} ·{" "}
                  {target.removalConfirmedAt ? "Media removed" : "Removal pending"}
                  {target.nextRetryAt
                    ? ` · next attempt ${new Date(target.nextRetryAt * 1000).toLocaleString()}`
                    : ""}
                </p>
                <p className="text-xs text-base-content/45 mt-1">
                  Last confirmed action: {lastConfirmedAction(target)}
                </p>
                {target.phase === "plex_reconciliation" && target.error && (
                  <p className="text-xs text-error mt-1">Last Plex error: {target.error}</p>
                )}
                {target.supersededReason && (
                  <p className="text-xs text-base-content/55 mt-1">{target.supersededReason}</p>
                )}
                {target.resolutionState === "management_hold" && (
                  <div className="alert alert-warning mt-3 block text-xs">
                    <p className="font-semibold">Radarr management hold</p>
                    <p className="mt-1">
                      This Radarr movie is reserved, so another coordinated deletion cannot begin.
                      Repair Radarr to the exact retained target state to resume, or restore its
                      exact original movie path and file to cancel safely. Verification reads live
                      Plex and Radarr state; it does not accept a claimed outcome.
                    </p>
                  </div>
                )}
                {target.radarrPathAdoption &&
                  target.radarrPathAdoption.mode !== "existing_path" && (
                  <div className="mt-3 rounded-lg border border-base-300 bg-base-200/40 p-3 text-xs">
                    <p className="font-semibold">Radarr retained-path adoption</p>
                    <dl className="mt-2 grid gap-1 break-all">
                      <div>Original path: {target.radarrPathAdoption.originalMoviePath}</div>
                      <div>Target path: {target.radarrPathAdoption.targetMoviePath}</div>
                      <div>Retained file: {target.radarrPathAdoption.retainedPath}</div>
                      <div>
                        Movie protected:{" "}
                        {target.radarrPathAdoption.transition?.pathUpdateAttemptedAt
                          ? "yes"
                          : "pending"}
                      </div>
                      <div>
                        Path changed: {target.radarrPathAdoption.transition?.pathConfirmedAt
                          ? "confirmed"
                          : "pending"}
                      </div>
                      <div>
                        Retained file adopted: {target.radarrPathAdoption.adoptedMovieFile
                          ? `yes (movie-file ${target.radarrPathAdoption.adoptedMovieFile.id})`
                          : "pending"}
                      </div>
                      <div>
                        Original monitored value restored:{" "}
                        {target.radarrPathAdoption.transition?.monitoringRestoredAt
                          ? "confirmed"
                          : "not yet"}
                      </div>
                    </dl>
                  </div>
                )}
                {target.radarrRemovalFallback && (
                  <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
                    <p className="font-semibold">Radarr movie removal</p>
                    <dl className="mt-2 grid gap-1 break-all">
                      <div>Selected Plex file: {target.radarrRemovalFallback.selectedPlexPath}</div>
                      <div>Retained Plex file: {target.radarrRemovalFallback.retainedPlexPath}</div>
                      <div>
                        Monitoring protection:{" "}
                        {target.radarrRemovalFallback.transition?.monitoringProtectedAt
                          ? "confirmed"
                          : "pending"}
                      </div>
                      <div>
                        Import exclusion:{" "}
                        {target.radarrRemovalFallback.transition?.exclusionConfirmedAt
                          ? "confirmed"
                          : "pending"}
                      </div>
                      <div>
                        Radarr removal:{" "}
                        {target.radarrRemovalFallback.transition?.movieAbsenceConfirmedAt
                          ? "confirmed"
                          : target.radarrRemovalFallback.transition?.removalAttemptedAt
                          ? "attempted"
                          : "pending"}
                      </div>
                    </dl>
                  </div>
                )}
              </div>
            </summary>
            {(target.relocationGuidanceState !== "none" ||
              target.relocationSyncBarrierState !== "none") && (
              <RelocationWorkflowCard
                operationId={operation.id}
                target={target}
                recoveryDefersSync={operation.libraryRecoveryTargetCount !== 1}
              />
            )}
            <TargetTimeline target={target} />
          </details>
        ))}
      </section>
      {resolveHold.isError && (
        <ErrorAlert
          message={resolveHold.error.message}
          onRetry={() => resolveHold.mutate()}
        />
      )}
    </div>
  );
}

function TargetTimeline({
  target,
}: {
  target: import("@plex-librarian/shared/types.ts").DeletionOperationTarget;
}) {
  const stages = [
    ["validating", "Safety checks"],
    ...(target.downloadCleanupSelected
      ? ([["download_cleanup", "Download cleanup"]] as const)
      : []),
    ...(target.arrCoordinationConfigured
      ? ([["arr_coordination", "Sonarr/Radarr coordination"]] as const)
      : []),
    ["plex_reconciliation", "Plex reconciliation"],
    ["finalizing", "Finalization"],
  ] as const;
  const current = stages.findIndex(([phase]) => phase === target.phase);
  return (
    <ol className="grid gap-1 border-t border-base-300 px-12 py-3 text-xs text-base-content/55">
      {stages.map(([phase, label], index) => (
        <li
          key={phase}
          className={index < current || target.status === "completed"
            ? "text-success"
            : index === current
            ? "font-medium text-base-content"
            : ""}
        >
          {index < current || target.status === "completed" ? "✓" : index === current ? "→" : "○"}
          {" "}
          {label}
        </li>
      ))}
      <li>Plex attempts: {target.plexAttemptCount}</li>
    </ol>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-base-content/45">{label}</p>
      <p className="text-lg font-semibold mt-1">{value}</p>
    </div>
  );
}

function statusBadge(status: string): string {
  if (status === "completed") return "badge-success";
  if (status === "needs_attention") return "badge-warning";
  if (status === "completed_with_warning") return "badge-warning";
  if (status === "cancelled") return "badge-ghost";
  return "badge-info";
}

function phaseLabel(phase: string): string {
  return (
    (
      {
        validating: "Safety checks",
        download_cleanup: "Download cleanup",
        arr_coordination: "Sonarr/Radarr coordination",
        plex_reconciliation: "Plex reconciliation",
        finalizing: "Finalization",
      } as Record<string, string>
    )[phase] ?? phase
  );
}

function lastConfirmedAction(
  target: import("@plex-librarian/shared/types.ts").DeletionOperationTarget,
): string {
  if (target.plexReconciledAt) return "Plex reconciliation confirmed";
  if (target.removalConfirmedAt) return "Media removal confirmed";
  if (target.phase === "plex_reconciliation" && target.arrCoordinationConfigured) {
    return "Sonarr/Radarr coordination confirmed";
  }
  if (target.phase === "arr_coordination" && target.downloadCleanupSelected) {
    return "Download cleanup confirmed";
  }
  return "Safety checks confirmed";
}
