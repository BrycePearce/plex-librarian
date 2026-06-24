import { createFileRoute, redirect, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient, skipToken } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { RefreshCw, Film, Tv, Music, AlertCircle, CheckCircle, LogOut } from 'lucide-react'
import { api } from '../lib/api'
import type { SyncLog, AuthStatus } from '../lib/api'
import { formatRelativeTime, formatDuration } from '../lib/format'

export const Route = createFileRoute('/dashboard')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData({
      queryKey: ['auth', 'status'],
      queryFn: api.auth.status,
      staleTime: 60_000,
    })
    if (!status.configured) throw redirect({ to: '/setup' })
  },
  component: DashboardPage,
})

function DashboardPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [activeSyncId, setActiveSyncId] = useState<number | null>(null)

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ['auth', 'status'],
    queryFn: api.auth.status,
    staleTime: 60_000,
  })

  const disconnect = useMutation({
    mutationFn: api.auth.disconnect,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['auth', 'status'] })
      void navigate({ to: '/setup' })
    },
  })

  const { data: librariesData, isLoading: libsLoading, error: libsError } = useQuery({
    queryKey: ['libraries'],
    queryFn: () => api.libraries.list(),
  })

  const { data: history } = useQuery({
    queryKey: ['sync', 'history'],
    queryFn: () => api.sync.history(5),
    refetchInterval: activeSyncId ? 3_000 : false,
  })

  const { data: activeSync } = useQuery({
    queryKey: ['sync', activeSyncId],
    queryFn: activeSyncId !== null ? () => api.sync.poll(activeSyncId) : skipToken,
    refetchInterval: (q) => q.state.data?.status === 'pending' ? 2_000 : false,
  })

  useEffect(() => {
    if (activeSyncId === null) return
    if (activeSync?.status === 'success') {
      void (async () => {
        await qc.invalidateQueries({ queryKey: ['libraries'] })
        await qc.invalidateQueries({ queryKey: ['sync', 'history'] })
        setActiveSyncId(null)
      })()
    } else if (activeSync?.status === 'error') {
      void qc.invalidateQueries({ queryKey: ['sync', 'history'] })
      setActiveSyncId(null)
    }
  }, [activeSync, activeSyncId, qc])

  const triggerSync = useMutation({
    mutationFn: () => api.sync.trigger(),
    onSuccess: (data) => setActiveSyncId(data.syncId),
  })

  const isSyncing = activeSyncId !== null || triggerSync.isPending

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Libraries</h1>
          <p className="text-base-content/50 text-sm mt-1">
            {librariesData ? `${librariesData.total} libraries` : '—'}
          </p>
        </div>
        <div className="flex gap-2">
          {authStatus?.source !== 'env' && (
            <button
              className="btn btn-ghost gap-2"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
              title="Disconnect from Plex"
            >
              <LogOut className="w-4 h-4" />
              Disconnect
            </button>
          )}
          <button
            className="btn btn-primary gap-2"
            onClick={() => triggerSync.mutate()}
            disabled={isSyncing}
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </div>

      {activeSync?.status === 'pending' && (
        <div className="alert">
          <span className="loading loading-spinner loading-sm" />
          <span>
            Sync in progress — {(activeSync.itemsProcessed ?? 0).toLocaleString()} items processed
          </span>
        </div>
      )}
      {activeSync?.status === 'error' && (
        <div className="alert alert-error">
          <AlertCircle className="w-4 h-4" />
          <span>Sync failed: {activeSync.error}</span>
        </div>
      )}
      {triggerSync.isError && (
        <div className="alert alert-warning">
          <AlertCircle className="w-4 h-4" />
          <span>{triggerSync.error.message}</span>
        </div>
      )}

      {libsLoading && (
        <div className="flex justify-center py-20">
          <span className="loading loading-spinner loading-lg" />
        </div>
      )}
      {libsError && (
        <div className="alert alert-error">
          <AlertCircle className="w-4 h-4" />
          <span>Failed to load libraries</span>
        </div>
      )}
      {librariesData && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {librariesData.libraries.map((lib) => (
            <Link
              key={lib.key}
              to="/libraries/$key/stale"
              params={{ key: lib.key }}
              className="card bg-base-200 hover:bg-base-300 transition-colors"
            >
              <div className="card-body gap-3">
                <div className="flex items-center gap-3">
                  <LibraryIcon type={lib.type} />
                  <div className="min-w-0">
                    <h2 className="font-semibold truncate">{lib.title}</h2>
                    <p className="text-xs text-base-content/40 capitalize">{lib.type}</p>
                  </div>
                </div>
                <div className="text-xs text-base-content/40">
                  Synced {formatRelativeTime(lib.syncedAt)}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {history && history.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Recent syncs</h2>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Items</th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => <SyncRow key={s.id} sync={s} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function LibraryIcon({ type }: { type: string }) {
  const cls = 'w-8 h-8 p-1.5 rounded-lg shrink-0'
  if (type === 'movie') return <Film className={`${cls} bg-primary/20 text-primary`} />
  if (type === 'show') return <Tv className={`${cls} bg-secondary/20 text-secondary`} />
  if (type === 'artist') return <Music className={`${cls} bg-accent/20 text-accent`} />
  return <Film className={`${cls} bg-base-300 text-base-content/40`} />
}

function SyncRow({ sync }: { sync: SyncLog }) {
  return (
    <tr>
      <td>
        {sync.status === 'pending' && (
          <span className="badge badge-info gap-1">
            <span className="loading loading-spinner loading-xs" /> pending
          </span>
        )}
        {sync.status === 'success' && (
          <span className="badge badge-success gap-1">
            <CheckCircle className="w-3 h-3" /> success
          </span>
        )}
        {sync.status === 'error' && (
          <span className="badge badge-error gap-1" title={sync.error ?? ''}>
            <AlertCircle className="w-3 h-3" /> error
          </span>
        )}
      </td>
      <td className="text-sm text-base-content/70">
        {new Date(sync.startedAt * 1000).toLocaleString()}
      </td>
      <td className="text-sm text-base-content/70">
        {sync.finishedAt ? formatDuration(sync.finishedAt - sync.startedAt) : '—'}
      </td>
      <td className="text-sm font-mono">{(sync.itemsProcessed ?? 0).toLocaleString()}</td>
    </tr>
  )
}

