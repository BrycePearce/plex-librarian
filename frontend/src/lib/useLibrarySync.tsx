import { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient, skipToken } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from './api'

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

  const { data: activeSync, isError: pollError } = useQuery({
    queryKey: ['sync', activeSyncId],
    queryFn: activeSyncId !== null ? () => api.sync.poll(activeSyncId) : skipToken,
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 2_000 : false),
  })

  useEffect(() => {
    if (activeSyncId === null) return
    if (pollError || activeSync?.status === 'success' || activeSync?.status === 'error') {
      void qc.invalidateQueries({ queryKey: ['libraries'] })
      void qc.invalidateQueries({ queryKey: ['stale', libraryKey] })
      void qc.invalidateQueries({ queryKey: ['sync', 'history'] })
      setActiveSyncId(null)
    }
  }, [activeSync, activeSyncId, pollError, libraryKey, qc])

  const mutation = useMutation({
    mutationFn: () => api.sync.triggerLibrary(libraryKey),
    onSuccess: (data) => setActiveSyncId(data.syncId),
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
