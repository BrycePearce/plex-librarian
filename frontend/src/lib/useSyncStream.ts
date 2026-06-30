import { useState, useEffect } from 'react'
import type { LibraryPhase, LibrarySyncProgress } from './api'

export type SyncStreamResult = {
  progress: LibrarySyncProgress[] | null
  isDone: boolean
  error: string | null
}

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

    const es = new EventSource(`/api/sync/${syncId}/events`)

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

    // EventSource stops reconnecting on 4xx/5xx — surface as an error so callers
    // don't get stuck waiting (e.g. server restart left a stale pending row in DB).
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setError('Lost connection to sync stream')
      }
    }

    return () => {
      es.close()
    }
  }, [syncId])

  return { progress, isDone, error }
}
