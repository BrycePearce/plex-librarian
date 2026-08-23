import { createFileRoute, Link } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  Copy,
  ExternalLink,
  History,
  RotateCcw,
  Trash2,
  UserX,
  XCircle,
} from "lucide-react";
import { api } from "../lib/api.ts";
import type { ActivityEvent, EventType } from "../lib/api.ts";
import { queryKeys } from "../lib/queryKeys.ts";
import { formatKilobytes, formatRelativeTime } from "../lib/format.ts";
import { ActivityListSkeleton } from "../components/Skeletons.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import "../components/dataSurfaces.css";
import { requireAuth } from "../lib/requireAuth.ts";
import { DataSurface, PageHeader } from "../components/Workspace.tsx";
import { deletionRecoverySummary } from "../features/deletionOperations/recoveryGuidance.ts";
import { DismissRecoveryDialog } from "../features/deletionOperations/DismissRecoveryDialog.tsx";
import { ServiceIcon } from "../components/ServiceIcons.tsx";

export const Route = createFileRoute("/activity")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: ActivityPage,
});

const PAGE_SIZE = 30;

function ActivityPage() {
  const queryClient = useQueryClient();
  const dismissDialogRef = useRef<HTMLDialogElement>(null);
  const [dismissTarget, setDismissTarget] = useState<{ id: string; title: string } | null>(null);
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.events.all,
    queryFn: ({ pageParam }: { pageParam: number | undefined }) =>
      api.events.list({ limit: PAGE_SIZE, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  // Events only carry libraryKey, not a title (see events table comment in schema.ts —
  // display text is rendered here, not persisted, so it can still change/localize for
  // events that already happened). Reuses the same cached ["libraries"] list the
  // dashboard fetches. A library dropped from Plex after the event was recorded just
  // falls back to its raw key below.
  const { data: librariesData } = useQuery({
    queryKey: queryKeys.libraries.all,
    queryFn: () => api.libraries.list(),
  });
  const attentionParams = { attention: true, limit: 100, offset: 0 };
  const attention = useQuery({
    queryKey: queryKeys.deletionOperations.list(attentionParams),
    queryFn: () => api.deletionOperations.list(attentionParams),
    refetchInterval: (query) => (query.state.data?.total ?? 0) > 0 ? 5_000 : false,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.deletionOperations.retry(id),
    onSuccess: (_operation, id) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deletionOperations.lists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deletionOperations.detail(id) });
    },
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.deletionOperations.dismiss(id),
    onSuccess: (_operation, id) => {
      dismissDialogRef.current?.close();
      void queryClient.invalidateQueries({ queryKey: queryKeys.deletionOperations.lists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deletionOperations.detail(id) });
    },
  });
  const libraryTitleByKey = new Map(
    (librariesData?.libraries ?? []).map((lib) => [lib.key, lib.title]),
  );

  const allEvents = data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <div className="workspace-page space-y-6 max-w-4xl">
      <PageHeader
        eyebrow="Audit trail"
        title="Activity"
        description="A chronological record of syncs, deletions, and access changes."
        icon={History}
      />

      {(attention.isLoading || attention.isError || (attention.data?.total ?? 0) > 0) && (
        <section className="space-y-3" aria-labelledby="needs-attention-title">
          <div>
            <h2 id="needs-attention-title" className="text-lg font-semibold">Needs attention</h2>
            <p className="text-sm text-base-content/55">
              Current deletion workflows that still own recovery state.
            </p>
          </div>
          {attention.isLoading && <span className="loading loading-spinner loading-sm" />}
          {attention.isError && (
            <div className="alert alert-error">
              <AlertCircle className="size-4" />
              <span>Failed to load deletion operations</span>
            </div>
          )}
          {attention.data && attention.data.operations.length > 0 && (
            <DataSurface className="divide-y divide-base-300">
              {attention.data.operations.map((operation) => (
                <div key={operation.id} className="px-4 py-4 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 max-w-2xl">
                      <p className="font-medium">
                        {operation.titles.join(", ") ||
                          `${operation.targetCount} deletion target(s)`}
                      </p>
                      <p className="text-sm text-error mt-1">
                        {operation.failureReasons.join(" · ") || "Deletion needs attention"}
                      </p>
                      <p className="text-xs text-base-content/60 mt-2">
                        <span className="font-semibold text-base-content/75">Recommended:</span>
                        {" "}
                        {deletionRecoverySummary(operation.failureReasons, operation.status)}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <ArrRecoveryLinks
                        operationId={operation.id}
                        hasCandidates={operation.arrDestinations.length > 0}
                      />
                      <Link
                        to="/deletion-operations/$id"
                        params={{ id: operation.id }}
                        className="btn btn-ghost btn-sm"
                      >
                        Open
                      </Link>
                      {operation.retryable && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={retry.isPending && retry.variables === operation.id}
                          onClick={() => retry.mutate(operation.id)}
                        >
                          <RotateCcw className="size-4" />
                          Recheck
                        </button>
                      )}
                      {operation.retryable && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={dismiss.isPending && dismiss.variables === operation.id}
                          onClick={() => {
                            dismiss.reset();
                            setDismissTarget({
                              id: operation.id,
                              title: operation.titles.join(", ") || "Deletion problem",
                            });
                            queueMicrotask(() => dismissDialogRef.current?.showModal());
                          }}
                        >
                          <XCircle className="size-4" />
                          Dismiss
                        </button>
                      )}
                    </div>
                  </div>
                  {retry.isError && retry.variables === operation.id && (
                    <p className="text-sm text-error" role="alert">
                      {retry.error.message}
                    </p>
                  )}
                </div>
              ))}
            </DataSurface>
          )}
        </section>
      )}

      <DismissRecoveryDialog
        dialogRef={dismissDialogRef}
        title={dismissTarget?.title ?? "Deletion problem"}
        pending={dismiss.isPending}
        error={dismiss.error}
        onConfirm={() => dismissTarget && dismiss.mutate(dismissTarget.id)}
        onClose={() => {
          if (dismiss.isPending) return;
          if (dismissDialogRef.current?.open) dismissDialogRef.current.close();
          dismiss.reset();
          setDismissTarget(null);
        }}
      />

      {isLoading && <ActivityListSkeleton />}

      {error && (
        <div className="alert alert-error">
          <AlertCircle className="w-4 h-4" />
          <span>Failed to load activity</span>
        </div>
      )}

      {!isLoading && !error && allEvents.length === 0 && (
        <EmptyState
          icon={History}
          title="No activity yet"
          description="Syncs, deletions, and access changes will leave a trail here."
        />
      )}

      {allEvents.length > 0 && (
        <DataSurface className="activity-feed divide-y divide-base-300">
          {allEvents.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              libraryTitleByKey={libraryTitleByKey}
            />
          ))}
        </DataSurface>
      )}

      {hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage
              ? <span className="loading loading-spinner loading-xs" />
              : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function ArrRecoveryLinks({
  operationId,
  hasCandidates,
}: {
  operationId: string;
  hasCandidates: boolean;
}) {
  const links = useQuery({
    queryKey: queryKeys.deletionOperations.arrLinks(operationId),
    queryFn: () => api.deletionOperations.arrLinks(operationId),
    enabled: hasCandidates,
    staleTime: 60_000,
    retry: false,
  });
  const resolved = links.data?.links ?? [];
  return resolved.map((link) => (
    <a
      key={`${link.targetId}:${link.instanceId}:${link.href}`}
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      className="btn btn-ghost btn-sm"
      title={`Open ${link.targetTitle} in ${link.instanceName}`}
      aria-label={`Open ${link.targetTitle} in ${link.instanceName}`}
    >
      <ServiceIcon service={link.instanceType} className="size-4" />
      {resolved.length > 1
        ? link.instanceName
        : link.instanceType === "sonarr"
        ? "Sonarr"
        : "Radarr"}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  ));
}

// EventType is a closed union, so these lookups cannot miss: TypeScript's
// Record<EventType, X> fails the build when a new type lacks a matching entry.
const EVENT_ICON: Record<EventType, typeof CheckCircle> = {
  "sync.completed": CheckCircle,
  "sync.failed": AlertCircle,
  "items.deleted": Trash2,
  "media.deleted": Copy,
  "deletion.completed": Trash2,
  "user.removed": UserX,
};

const EVENT_ICON_CLASS: Record<EventType, string> = {
  "sync.completed": "text-success",
  "sync.failed": "text-error",
  "items.deleted": "text-warning",
  "media.deleted": "text-warning",
  "deletion.completed": "text-warning",
  "user.removed": "text-error",
};

function libraryLabel(
  libraryKey: string,
  titleByKey: Map<string, string>,
): string {
  return titleByKey.get(libraryKey) ?? libraryKey;
}

// Renders the human-readable line from `type` + `payload` at display time rather than
// reading a persisted string — see the `events` table comment in schema.ts for why.
function describeEvent(
  event: ActivityEvent,
  titleByKey: Map<string, string>,
): string {
  if (!event.payload) return event.type;
  switch (event.type) {
    case "sync.completed": {
      const { libraryKey, itemsProcessed } = event.payload;
      return libraryKey
        ? `Synced ${libraryLabel(libraryKey, titleByKey)} — ${itemsProcessed} item(s)`
        : `Full sync completed — ${itemsProcessed} item(s)`;
    }
    case "sync.failed": {
      const { libraryKey, error } = event.payload;
      return libraryKey
        ? `Sync failed for ${libraryLabel(libraryKey, titleByKey)}: ${error}`
        : `Full sync failed: ${error}`;
    }
    case "items.deleted": {
      const { libraryKey, deletedCount, failedCount, partialCount = 0 } = event.payload;
      const label = libraryLabel(libraryKey, titleByKey);
      if (failedCount === 0 && partialCount === 0) {
        return `Deleted ${deletedCount} item(s) from ${label}`;
      }
      if (deletedCount === 0 && partialCount === 0) {
        return `Failed to delete ${failedCount} item(s) from ${label}`;
      }
      const outcomes = [
        partialCount > 0 ? `${partialCount} partial` : null,
        failedCount > 0 ? `${failedCount} failed` : null,
      ].filter(Boolean).join(", ");
      return `Deleted ${deletedCount} item(s) from ${label} (${outcomes})`;
    }
    case "media.deleted": {
      const { libraryKey, title } = event.payload;
      return `Removed a duplicate version of ${title} from ${libraryLabel(libraryKey, titleByKey)}`;
    }
    case "deletion.completed": {
      const {
        libraryKey,
        completedCount,
        warningCount = 0,
        failedCount,
        cancelledCount,
        supersededCount = 0,
      } = event.payload;
      const label = libraryLabel(libraryKey, titleByKey);
      const suffix = [
        failedCount > 0 ? `${failedCount} failed` : null,
        warningCount > 0 ? `${warningCount} warning` : null,
        supersededCount > 0 ? `${supersededCount} superseded` : null,
        cancelledCount - supersededCount > 0
          ? `${cancelledCount - supersededCount} cancelled`
          : null,
      ].filter(Boolean).join(", ");
      return `Deletion finished for ${label}: ${completedCount} completed${
        suffix ? ` (${suffix})` : ""
      }`;
    }
    case "user.removed": {
      const { username } = event.payload;
      return `Removed ${username}'s access to this server`;
    }
  }
}

function EventRow(
  { event, libraryTitleByKey }: {
    event: ActivityEvent;
    libraryTitleByKey: Map<string, string>;
  },
) {
  // Any failed item in a delete batch is functionally a failure worth flagging, not
  // just a full 0-deleted wipeout — give it the same error styling as sync.failed
  // instead of the neutral "items deleted" warning treatment, so a half-failed delete
  // isn't visually indistinguishable from a fully successful one.
  const hasFailedDelete = (event.type === "items.deleted" &&
    !!event.payload &&
    (event.payload.failedCount > 0 || (event.payload.partialCount ?? 0) > 0)) ||
    (event.type === "deletion.completed" && !!event.payload &&
      (event.payload.failedCount > 0 || event.payload.cancelledCount > 0));
  const Icon = hasFailedDelete ? AlertCircle : EVENT_ICON[event.type];
  const iconClass = hasFailedDelete ? "text-error" : EVENT_ICON_CLASS[event.type];
  // Only show logical size when something was actually removed — otherwise a fully-failed
  // delete attempt renders a misleading size next to its failure summary.
  const fileSizeFreed = event.type === "items.deleted" && event.payload &&
      event.payload.deletedCount > 0
    ? event.payload.fileSizeFreed
    : event.type === "media.deleted" && event.payload
    ? event.payload.fileSizeFreed
    : event.type === "deletion.completed" && event.payload &&
        (event.payload.removalConfirmedCount ?? event.payload.completedCount) > 0
    ? event.payload.logicalSizeRemoved
    : undefined;

  const row = (
    <div className="polished-row">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <Icon className={`w-4 h-4 shrink-0 ${iconClass}`} />
        <span className="text-sm flex-1 min-w-0 truncate">
          {describeEvent(event, libraryTitleByKey)}
        </span>
        {fileSizeFreed !== undefined && (
          <span className="text-xs font-mono text-base-content/40 shrink-0">
            {formatKilobytes(fileSizeFreed)} logical size removed
          </span>
        )}
        <span
          className="text-xs text-base-content/40 shrink-0"
          title={new Date(event.createdAt * 1000).toLocaleString()}
        >
          {formatRelativeTime(event.createdAt)}
        </span>
      </div>
    </div>
  );
  if (event.type === "deletion.completed" && event.payload?.operationId) {
    return (
      <Link
        to="/deletion-operations/$id"
        params={{ id: event.payload.operationId }}
        className="block rounded-lg focus-visible:outline-2 focus-visible:outline-primary"
        aria-label="Review deletion operation"
      >
        {row}
      </Link>
    );
  }
  return row;
}
