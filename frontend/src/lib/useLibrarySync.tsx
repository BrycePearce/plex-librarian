import { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from './api'
import { useSyncStream } from './useSyncStream'

// Shared across every caller (dashboard's "Recent syncs" list, per-library reattach
// below) so they all read the same cached list instead of each issuing their own fetch.
export function useSyncHistory() {
  return useQuery({
    queryKey: ['sync', 'history'],
    queryFn: () => api.sync.history(10),
  })
}

type SyncContextValue = {
  increment: () => void
  decrement: () => void
  count: number
}

const ActiveSyncContext = createContext<SyncContextValue>({
  increment: () => {},
  decrement: () => {},
  count: 0,
})

export function LibrarySyncProvider({ children }: { children: ReactNode }): JSX.Element {
  const [count, setCount] = useState(0)
  const increment = useCallback(() => setCount((c) => c + 1), [])
  const decrement = useCallback(() => setCount((c) => Math.max(0, c - 1)), [])
  return (
    <ActiveSyncContext.Provider value={{ increment, decrement, count }}>
      {children}
    </ActiveSyncContext.Provider>
  )
}

export function useAnyLibrarySyncing(): boolean {
  return useContext(ActiveSyncContext).count > 0
}

export function useLibrarySync(libraryKey: string) {
  const qc = useQueryClient()
  const { increment, decrement } = useContext(ActiveSyncContext)
  // A pending sync we've attached to is either scoped to just this library (triggered
  // from this page's own "Sync" button, or reattached to one still running after a
  // remount) or a global "Sync all" run (libraryKey: null on the sync_log row) that
  // happens to include this library. The two need different "is this library done yet"
  // logic below, since a global run's overall completion covers every library, not just
  // this one — id and scope always change together, hence one state slot for both.
  const [attached, setAttached] = useState<{ id: number; scope: 'library' | 'global' } | null>(
    null,
  )

  const { progress, isDone, error: syncError } = useSyncStream(attached?.id ?? null)

  // Re-attach to a sync still pending server-side after this component mounts/remounts
  // (e.g. navigating away mid-sync and back, or opening this library while a "Sync all"
  // triggered from the dashboard is still running) — otherwise `attached` stays null
  // and this hook has no way to know a sync affecting this library is in progress.
  const { data: history } = useSyncHistory()
  useEffect(() => {
    if (attached !== null) return
    const pending = history?.find((h) =>
      h.status === 'pending' && (h.libraryKey === libraryKey || h.libraryKey === null)
    )
    if (pending) setAttached({ id: pending.id, scope: pending.libraryKey === null ? 'global' : 'library' })
  }, [history, attached, libraryKey])

  // For a global run, this library's SSE progress entry reaching the 'done' phase means
  // *this* library's data is ready — no need to wait for every other library in the run.
  const thisLibraryPhase = progress?.find((lib) => lib.key === libraryKey)?.phase
  const isThisLibraryDone = attached?.scope === 'global' ? thisLibraryPhase === 'done' : isDone

  useEffect(() => {
    if (attached === null) return
    if (!isThisLibraryDone && syncError === null) return
    void qc.invalidateQueries({ queryKey: ['libraries'] })
    void qc.invalidateQueries({ queryKey: ['stale', libraryKey] })
    // A global run's own history-list entry doesn't flip to 'success' until every
    // library finishes, so only invalidate it once the whole thing is actually over.
    if (attached.scope !== 'global' || isDone || syncError !== null) {
      void qc.invalidateQueries({ queryKey: ['sync', 'history'] })
    }
    setAttached(null)
  }, [isThisLibraryDone, isDone, syncError, attached, libraryKey, qc])

  const mutation = useMutation({
    mutationFn: () => api.sync.triggerLibrary(libraryKey),
    onSuccess: (data) => {
      setAttached({ id: data.syncId, scope: 'library' })
      void qc.invalidateQueries({ queryKey: ['sync', 'history'] })
    },
  })

  const isSyncing = (attached !== null && !isThisLibraryDone) || mutation.isPending

  // Register with context so DashboardPage can gate the "Sync all" button.
  const prevSyncing = useRef(false)
  useEffect(() => {
    if (isSyncing && !prevSyncing.current) {
      prevSyncing.current = true
      increment()
    } else if (!isSyncing && prevSyncing.current) {
      prevSyncing.current = false
      decrement()
    }
  }, [isSyncing, increment, decrement])

  // Decrement on unmount if still registered as active.
  useEffect(() => () => { if (prevSyncing.current) decrement() }, [decrement])

  return {
    isSyncing,
    trigger: () => mutation.mutate(),
    isError: mutation.isError,
    error: mutation.error,
  }
}
