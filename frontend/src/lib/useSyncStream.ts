import { useState, useEffect } from 'react'
import { api } from './api'
import type { LibraryPhase, LibrarySyncProgress } from './api'

export type SyncStreamResult = {
  progress: LibrarySyncProgress[] | null
  isDone: boolean
  error: string | null
}

// Reconnect backoff for dropped SSE streams (see onerror below). Capped so a genuinely
// dead backend (container restarting, host rebooting) eventually surfaces an error
// instead of polling forever with no feedback.
const MAX_RECONNECT_ATTEMPTS = 8
const BASE_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 30_000

export function useSyncStream(syncId: number | null): SyncStreamResult {
  const [progress, setProgress] = useState<LibrarySyncProgress[] | null>(null)
  const [isDone, setIsDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (syncId === null) {
      setProgress(null)
      setIsDone(false)
      setError(null)
      return
    }

    setProgress(null)
    setIsDone(false)
    setError(null)

    let cancelled = false
    let es: EventSource
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const scheduleReconnect = () => {
      attempt += 1
      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        setError('Lost connection to sync stream')
        return
      }
      // Exponential backoff with jitter so a shared server restart doesn't get every
      // open tab retrying in lockstep.
      const delay =
        Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1)) +
        Math.random() * 250
      reconnectTimer = setTimeout(() => {
        if (!cancelled) connect()
      }, delay)
    }

    const connect = () => {
      es = new EventSource(`/api/sync/${syncId}/events`)

      // A stream that actually connects means the backend is reachable again — reset
      // backoff so a single blip doesn't count against the retry budget for a later one.
      es.onopen = () => {
        attempt = 0
      }

      es.addEventListener('libraries', (e) => {
        const { libraries } = JSON.parse((e as MessageEvent).data) as {
          libraries: Array<{ key: string; title: string }>
        }
        setProgress(
          libraries.map((lib) => ({ key: lib.key, title: lib.title, phase: 'pending' as LibraryPhase, count: 0 })),
        )
      })

      es.addEventListener('phase', (e) => {
        const { libraryKey, phase, elapsedSeconds } = JSON.parse((e as MessageEvent).data) as {
          libraryKey: string
          phase: LibraryPhase
          elapsedSeconds?: number
        }
        setProgress((prev) =>
          prev?.map((lib) =>
            lib.key === libraryKey
              ? { ...lib, phase, ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}) }
              : lib,
          ) ?? null,
        )
      })

      es.addEventListener('count', (e) => {
        const { libraryKey, delta } = JSON.parse((e as MessageEvent).data) as {
          libraryKey: string
          delta: number
        }
        setProgress((prev) =>
          prev?.map((lib) => (lib.key === libraryKey ? { ...lib, count: lib.count + delta } : lib)) ?? null,
        )
      })

      es.addEventListener('complete', () => {
        es.close()
        setIsDone(true)
      })

      es.addEventListener('sync-error', (e) => {
        const { error: msg } = JSON.parse((e as MessageEvent).data) as { error: string }
        es.close()
        setError(msg)
      })

      // A dropped stream doesn't mean the sync itself stopped — e.g. triggering several
      // syncs at once can exceed the browser's per-origin connection limit and drop one of
      // them while the backend keeps running fine. Check the sync's real status via the
      // plain REST endpoint before giving up: reconnect if it's still going, and only
      // report done/error once that's actually true.
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED) return
        es.close()
        void api.sync.poll(syncId).then((row) => {
          if (cancelled) return
          if (row.progress) setProgress(row.progress)
          if (row.status === 'success') {
            setIsDone(true)
          } else if (row.status === 'error') {
            setError(row.error ?? 'Sync failed')
          } else {
            scheduleReconnect()
          }
        }).catch(() => {
          if (!cancelled) scheduleReconnect()
        })
      }
    }

    connect()

    return () => {
      cancelled = true
      clearTimeout(reconnectTimer)
      es.close()
    }
  }, [syncId])

  return { progress, isDone, error }
}
