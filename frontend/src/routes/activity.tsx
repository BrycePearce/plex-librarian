import { createFileRoute, Link } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle, Copy, History, Trash2, UserX } from "lucide-react";
import { api } from "../lib/api";
import type { ActivityEvent, EventType } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import { formatKilobytes, formatRelativeTime } from "../lib/format";
import { ActivityListSkeleton } from "../components/Skeletons";
import { EmptyState } from "../components/EmptyState";
import "../components/dataSurfaces.css";
import { requireAuth } from "../lib/requireAuth";
import { DataSurface, PageHeader } from "../components/Workspace";

export const Route = createFileRoute("/activity")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: ActivityPage,
});

const PAGE_SIZE = 30;

function ActivityPage() {
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
      const { libraryKey, completedCount, failedCount, cancelledCount } = event.payload;
      const label = libraryLabel(libraryKey, titleByKey);
      const suffix = [
        failedCount > 0 ? `${failedCount} failed` : null,
        cancelledCount > 0 ? `${cancelledCount} cancelled` : null,
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
  // Only show "N freed" when something was actually deleted — otherwise a fully-failed
  // delete attempt renders a misleading "0 KB freed" next to its failure summary.
  const fileSizeFreed = event.type === "items.deleted" && event.payload &&
      event.payload.deletedCount > 0
    ? event.payload.fileSizeFreed
    : event.type === "media.deleted" && event.payload
    ? event.payload.fileSizeFreed
    : event.type === "deletion.completed" && event.payload &&
        event.payload.completedCount > 0
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
            {formatKilobytes(fileSizeFreed)} freed
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
