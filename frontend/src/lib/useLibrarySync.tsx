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
  const [activeSyncId, setActiveSyncId] = useState<number | null>(null)

  const { isDone, error: syncError } = useSyncStream(activeSyncId)

  // Re-attach to a sync still pending server-side after this component remounts (e.g.
  // navigating away mid-sync and back) — otherwise activeSyncId resets to null on mount
  // and the button stops spinning even though the sync is still running.
  const { data: history } = useSyncHistory()
  useEffect(() => {
    if (activeSyncId !== null) return
    const pending = history?.find((h) => h.status === 'pending' && h.libraryKey === libraryKey)
    if (pending) setActiveSyncId(pending.id)
  }, [history, activeSyncId, libraryKey])

  useEffect(() => {
    if (activeSyncId === null) return
    if (!isDone && syncError === null) return
    void qc.invalidateQueries({ queryKey: ['libraries'] })
    void qc.invalidateQueries({ queryKey: ['stale', libraryKey] })
    void qc.invalidateQueries({ queryKey: ['sync', 'history'] })
    setActiveSyncId(null)
  }, [isDone, syncError, activeSyncId, libraryKey, qc])

  const mutation = useMutation({
    mutationFn: () => api.sync.triggerLibrary(libraryKey),
    onSuccess: (data) => {
      setActiveSyncId(data.syncId)
      void qc.invalidateQueries({ queryKey: ['sync', 'history'] })
    },
  })

  const isSyncing = activeSyncId !== null || mutation.isPending

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
