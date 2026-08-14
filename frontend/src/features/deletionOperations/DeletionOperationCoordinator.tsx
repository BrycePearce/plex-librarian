import { Link, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock3, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { api } from "../../lib/api.ts";
import { formatKilobytes } from "../../lib/format.ts";
import { queryKeys } from "../../lib/queryKeys.ts";
import {
  activeDeletionStatuses,
  deletionAttentionSummary,
  deletionOperationPollInterval,
  deletionWarningSummary,
  retryableRelocationSafeTargetCount,
} from "../../routes/-deletionOperationState.ts";

interface TrackedDeletion {
  id: string;
  invalidateQueryKeys: QueryKey[];
}

interface DeletionOperationContextValue {
  trackDeletionOperation: (id: string, invalidateQueryKeys: QueryKey[]) => void;
}

const DeletionOperationContext = createContext<
  DeletionOperationContextValue | null
>(null);

export function useDeletionOperationTracker(): DeletionOperationContextValue {
  const context = useContext(DeletionOperationContext);
  if (!context) {
    throw new Error(
      "useDeletionOperationTracker must be used within DeletionOperationCoordinator",
    );
  }
  return context;
}

export function DeletionOperationCoordinator({
  children,
}: {
  children: React.ReactNode;
}) {
  const [tracked, setTracked] = useState<TrackedDeletion[]>([]);

  const trackDeletionOperation = useCallback(
    (id: string, invalidateQueryKeys: QueryKey[]) => {
      setTracked((current) => {
        if (current.some((operation) => operation.id === id)) return current;
        return [...current, { id, invalidateQueryKeys }];
      });
    },
    [],
  );

  const dismiss = useCallback((id: string) => {
    setTracked((current) => current.filter((operation) => operation.id !== id));
  }, []);

  return (
    <DeletionOperationContext.Provider value={{ trackDeletionOperation }}>
      {children}
      <div className="fixed right-4 bottom-4 sm:right-6 sm:bottom-6 z-50 flex w-[calc(100%-2rem)] max-w-md flex-col gap-3">
        <AnimatePresence initial={false}>
          {tracked.map((operation) => (
            <DeletionOperationToast
              key={operation.id}
              operation={operation}
              onDismiss={dismiss}
            />
          ))}
        </AnimatePresence>
      </div>
    </DeletionOperationContext.Provider>
  );
}

function DeletionOperationToast({
  operation,
  onDismiss,
}: {
  operation: TrackedDeletion;
  onDismiss: (id: string) => void;
}) {
  const qc = useQueryClient();
  const reduceMotion = useReducedMotion();
  const terminalHandled = useRef(false);
  const viewingThisOperation = useRouterState({
    select: (state) =>
      state.matches.some((match) =>
        match.routeId === "/deletion-operations/$id" && match.params.id === operation.id
      ),
  });
  const query = useQuery({
    queryKey: queryKeys.deletionOperations.detail(operation.id),
    queryFn: () => api.deletionOperations.get(operation.id),
    refetchInterval: (state) => {
      if (
        state.state.data?.targets.some(
          (target) =>
            target.phase === "plex_reconciliation" &&
            (target.status === "needs_attention" ||
              target.status === "completed_with_warning"),
        )
      ) {
        return 5_000;
      }
      const status = state.state.data?.status;
      return status ? deletionOperationPollInterval(status, state.state.data?.nextRetryAt) : 2_000;
    },
  });
  const data = query.data;
  const active = !data || activeDeletionStatuses.has(data.status);
  const recheck = useMutation({
    mutationFn: () => api.deletionOperations.retry(operation.id),
    onSuccess: (updated) => {
      qc.setQueryData(queryKeys.deletionOperations.detail(operation.id), updated);
    },
  });

  useEffect(() => {
    if (active) {
      terminalHandled.current = false;
      return;
    }
    if (!data || terminalHandled.current) return;
    terminalHandled.current = true;
    for (const queryKey of operation.invalidateQueryKeys) {
      void qc.invalidateQueries({ queryKey });
    }
  }, [active, data, operation, qc]);

  useEffect(() => {
    if (
      !data || active || data.status === "needs_attention" ||
      data.status === "completed_with_warning"
    ) return;
    const timeout = globalThis.setTimeout(
      () => onDismiss(operation.id),
      5_000,
    );
    return () => globalThis.clearTimeout(timeout);
  }, [active, data, onDismiss, operation.id]);

  const current = data?.targets.find((target) => target.status === "running") ??
    data?.targets.find(
      (target) => target.status === "waiting_retry" || target.status === "queued",
    );
  const needsAttention = data?.status === "needs_attention";
  const completed = data?.status === "completed";
  const warning = data?.status === "completed_with_warning";
  const ordinaryTargets = data?.targets.filter(
    (target) => target.resolutionState !== "management_hold",
  ) ?? [];
  const recheckable = retryableRelocationSafeTargetCount(ordinaryTargets, "needs_attention") +
      retryableRelocationSafeTargetCount(ordinaryTargets, "completed_with_warning") > 0;

  return (
    <motion.div
      layout={!reduceMotion}
      role="status"
      aria-live="polite"
      initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
      className={`rounded-xl border bg-base-100 p-4 shadow-xl ${
        needsAttention || warning ? "border-warning/50" : "border-base-300"
      }`}
    >
      <div className="flex items-start gap-3">
        {completed
          ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
          : needsAttention || warning
          ? <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" />
          : data?.status === "cancelled"
          ? <X className="mt-0.5 size-5 shrink-0 text-base-content/50" />
          : query.isError
          ? <Clock3 className="mt-0.5 size-5 shrink-0 text-warning" />
          : <span className="loading loading-spinner loading-sm mt-0.5 shrink-0 text-primary" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {completed
              ? "Deletion complete"
              : warning
              ? "Deletion completed with warning"
              : needsAttention
              ? "Deletion needs attention"
              : data?.status === "cancelled"
              ? "Deletion cancelled"
              : query.isError
              ? "Checking deletion status…"
              : "Deleting media…"}
          </p>
          <p className="mt-0.5 truncate text-sm text-base-content/60">
            {completed && data
              ? `${data.completedCount} item${data.completedCount === 1 ? "" : "s"} removed · ${
                formatKilobytes(data.logicalSizeRemoved)
              } logical size removed`
              : warning && data
              ? deletionWarningSummary(data.removalConfirmedCount, data.warningCount)
              : needsAttention && data
              ? deletionAttentionSummary(data.removalConfirmedCount, data.failedCount)
              : current
              ? `${current.title} · ${
                current.phase === "plex_reconciliation"
                  ? "Updating Plex"
                  : current.status.replace(/_/g, " ")
              }`
              : data
              ? `${data.removalConfirmedCount} removed · ${data.failedCount} failed`
              : "Starting operation"}
          </p>
          {(warning || needsAttention) && recheckable && (
            <button
              type="button"
              className="btn btn-warning btn-xs mt-2"
              disabled={recheck.isPending}
              onClick={() => recheck.mutate()}
            >
              Recheck
            </button>
          )}
          {recheck.isError && (
            <p className="mt-2 text-xs text-error" role="alert">{recheck.error.message}</p>
          )}
          {!viewingThisOperation && (
            <Link
              to="/deletion-operations/$id"
              params={{ id: operation.id }}
              className="btn btn-ghost btn-xs mt-2 -ml-2"
            >
              {active ? "View progress" : "View details"}
            </Link>
          )}
        </div>
        {!active && (
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square shrink-0"
            aria-label="Dismiss deletion notification"
            onClick={() => onDismiss(operation.id)}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </motion.div>
  );
}
