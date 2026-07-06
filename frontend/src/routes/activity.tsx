import { createFileRoute, redirect, Link } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowLeft, AlertCircle, CheckCircle, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import type { ActivityEvent, EventType } from '../lib/api'
import { formatKilobytes, formatRelativeTime } from '../lib/format'

export const Route = createFileRoute('/activity')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ['auth', 'status'],
      queryFn: api.auth.status,
      staleTime: 60_000,
    })
    if (!status.configured) throw redirect({ to: '/setup' })
  },
  component: ActivityPage,
})

const PAGE_SIZE = 30

function ActivityPage() {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['events'],
      queryFn: ({ pageParam }: { pageParam: number | undefined }) =>
        api.events.list({ limit: PAGE_SIZE, before: pageParam }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    })

  // Events only carry libraryKey, not a title (see events table comment in schema.ts —
  // display text is rendered here, not persisted, so it can still change/localize for
  // events that already happened). Reuses the same cached ["libraries"] list the
  // dashboard fetches. A library dropped from Plex after the event was recorded just
  // falls back to its raw key below.
  const { data: librariesData } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.libraries.list(),
  })
  const libraryTitleByKey = new Map(
    (librariesData?.libraries ?? []).map((lib) => [lib.key, lib.title]),
  )

  const allEvents = data?.pages.flatMap((p) => p.events) ?? []

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Link to="/dashboard" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <h1 className="text-2xl font-bold">Activity</h1>
      </div>

      {isLoading && (
        <div className="flex justify-center py-12">
          <span className="loading loading-spinner loading-md" />
        </div>
      )}

      {error && (
        <div className="alert alert-error">
          <AlertCircle className="w-4 h-4" />
          <span>Failed to load activity</span>
        </div>
      )}

      {!isLoading && !error && allEvents.length === 0 && (
        <p className="text-base-content/40 text-sm">No activity yet.</p>
      )}

      {allEvents.length > 0 && (
        <div className="space-y-2">
          {allEvents.map((event) => (
            <EventRow key={event.id} event={event} libraryTitleByKey={libraryTitleByKey} />
          ))}
        </div>
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
              : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}

// EventType is a closed union with all 3 members covered below, so these lookups can
// never miss — TypeScript's Record<EventType, X> already fails the build if a 4th
// EventType is ever added without a matching entry here.
const EVENT_ICON: Record<EventType, typeof CheckCircle> = {
  'sync.completed': CheckCircle,
  'sync.failed': AlertCircle,
  'items.deleted': Trash2,
}

const EVENT_ICON_CLASS: Record<EventType, string> = {
  'sync.completed': 'text-success',
  'sync.failed': 'text-error',
  'items.deleted': 'text-warning',
}

function libraryLabel(libraryKey: string, titleByKey: Map<string, string>): string {
  return titleByKey.get(libraryKey) ?? libraryKey
}

// Renders the human-readable line from `type` + `payload` at display time rather than
// reading a persisted string — see the `events` table comment in schema.ts for why.
function describeEvent(event: ActivityEvent, titleByKey: Map<string, string>): string {
  if (!event.payload) return event.type
  switch (event.type) {
    case 'sync.completed': {
      const { libraryKey, itemsProcessed } = event.payload
      return libraryKey
        ? `Synced ${libraryLabel(libraryKey, titleByKey)} — ${itemsProcessed} item(s)`
        : `Full sync completed — ${itemsProcessed} item(s)`
    }
    case 'sync.failed': {
      const { libraryKey, error } = event.payload
      return libraryKey
        ? `Sync failed for ${libraryLabel(libraryKey, titleByKey)}: ${error}`
        : `Full sync failed: ${error}`
    }
    case 'items.deleted': {
      const { libraryKey, deletedCount, failedCount } = event.payload
      const label = libraryLabel(libraryKey, titleByKey)
      if (failedCount === 0) return `Deleted ${deletedCount} item(s) from ${label}`
      if (deletedCount === 0) return `Failed to delete ${failedCount} item(s) from ${label}`
      return `Deleted ${deletedCount} item(s) from ${label} (${failedCount} failed)`
    }
  }
}

function EventRow(
  { event, libraryTitleByKey }: { event: ActivityEvent; libraryTitleByKey: Map<string, string> },
) {
  // Any failed item in a delete batch is functionally a failure worth flagging, not
  // just a full 0-deleted wipeout — give it the same error styling as sync.failed
  // instead of the neutral "items deleted" warning treatment, so a half-failed delete
  // isn't visually indistinguishable from a fully successful one.
  const hasFailedDelete = event.type === 'items.deleted' &&
    !!event.payload && event.payload.failedCount > 0
  const Icon = hasFailedDelete ? AlertCircle : EVENT_ICON[event.type]
  const iconClass = hasFailedDelete ? 'text-error' : EVENT_ICON_CLASS[event.type]
  // Only show "N freed" when something was actually deleted — otherwise a fully-failed
  // delete attempt renders a misleading "0 KB freed" next to its failure summary.
  const fileSizeFreed = event.type === 'items.deleted' && event.payload &&
      event.payload.deletedCount > 0
    ? event.payload.fileSizeFreed
    : undefined

  return (
    <div className="card bg-base-200">
      <div className="card-body flex-row items-center gap-3 py-3">
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
  )
}
