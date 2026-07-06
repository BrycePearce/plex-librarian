import { useSyncExternalStore } from 'react'
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

type StreamState = SyncStreamResult

const EMPTY_STATE: StreamState = { progress: null, isDone: false, error: null }

type Connection = {
  state: StreamState
  listeners: Set<() => void>
  es: EventSource | null
  reconnectTimer: ReturnType<typeof setTimeout> | undefined
  attempt: number
  closed: boolean
}

// Multiple components can watch the same syncId at once — the dashboard's own progress
// panel plus every visible LibraryCard's useLibrarySync, all reattaching to one "Sync
// all" run. Share a single real EventSource per syncId across them instead of each
// opening its own: besides being wasteful, opening as many connections as there are
// libraries can exceed the browser's per-origin connection limit and starve/drop some of
// them (the very problem the onerror recovery below was written for, just multiplied by
// library count) — this scales to however many libraries a user has, since it's always
// exactly one connection per active sync no matter how many components watch it.
const connections = new Map<number, Connection>()

function emit(conn: Connection): void {
  for (const listener of conn.listeners) listener()
}

function scheduleReconnect(syncId: number, conn: Connection): void {
  conn.attempt += 1
  if (conn.attempt > MAX_RECONNECT_ATTEMPTS) {
    conn.state = { ...conn.state, error: 'Lost connection to sync stream' }
    emit(conn)
    return
  }
  // Exponential backoff with jitter so a shared server restart doesn't get every
  // open tab retrying in lockstep.
  const delay =
    Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** (conn.attempt - 1)) +
    Math.random() * 250
  conn.reconnectTimer = setTimeout(() => {
    if (!conn.closed) connect(syncId, conn)
  }, delay)
}

function connect(syncId: number, conn: Connection): void {
  const es = new EventSource(`/api/sync/${syncId}/events`)
  conn.es = es

  // A stream that actually connects means the backend is reachable again — reset
  // backoff so a single blip doesn't count against the retry budget for a later one.
  es.onopen = () => {
    conn.attempt = 0
  }

  es.addEventListener('libraries', (e) => {
    const { libraries } = JSON.parse((e as MessageEvent).data) as {
      libraries: Array<{ key: string; title: string }>
    }
    conn.state = {
      ...conn.state,
      progress: libraries.map((lib) => ({
        key: lib.key,
        title: lib.title,
        phase: 'pending' as LibraryPhase,
        count: 0,
      })),
    }
    emit(conn)
  })

  es.addEventListener('phase', (e) => {
    const { libraryKey, phase, elapsedSeconds } = JSON.parse((e as MessageEvent).data) as {
      libraryKey: string
      phase: LibraryPhase
      elapsedSeconds?: number
    }
    conn.state = {
      ...conn.state,
      progress:
        conn.state.progress?.map((lib) =>
          lib.key === libraryKey
            ? { ...lib, phase, ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}) }
            : lib,
        ) ?? null,
    }
    emit(conn)
  })

  es.addEventListener('count', (e) => {
    const { libraryKey, delta } = JSON.parse((e as MessageEvent).data) as {
      libraryKey: string
      delta: number
    }
    conn.state = {
      ...conn.state,
      progress:
        conn.state.progress?.map((lib) =>
          lib.key === libraryKey ? { ...lib, count: lib.count + delta } : lib
        ) ?? null,
    }
    emit(conn)
  })

  es.addEventListener('complete', () => {
    es.close()
    conn.state = { ...conn.state, isDone: true }
    emit(conn)
  })

  es.addEventListener('sync-error', (e) => {
    const { error: msg } = JSON.parse((e as MessageEvent).data) as { error: string }
    es.close()
    conn.state = { ...conn.state, error: msg }
    emit(conn)
  })

  // A dropped stream doesn't mean the sync itself stopped — e.g. a shaky connection can
  // drop this one stream while the backend keeps running fine. Check the sync's real
  // status via the plain REST endpoint before giving up: reconnect if it's still going,
  // and only report done/error once that's actually true.
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) return
    es.close()
    void api.sync.poll(syncId).then((row) => {
      if (conn.closed) return
      if (row.progress) conn.state = { ...conn.state, progress: row.progress }
      if (row.status === 'success') {
        conn.state = { ...conn.state, isDone: true }
        emit(conn)
      } else if (row.status === 'error') {
        conn.state = { ...conn.state, error: row.error ?? 'Sync failed' }
        emit(conn)
      } else {
        emit(conn)
        scheduleReconnect(syncId, conn)
      }
    }).catch(() => {
      if (!conn.closed) scheduleReconnect(syncId, conn)
    })
  }
}

function getConnection(syncId: number): Connection {
  let conn = connections.get(syncId)
  if (!conn) {
    conn = {
      state: EMPTY_STATE,
      listeners: new Set(),
      es: null,
      reconnectTimer: undefined,
      attempt: 0,
      closed: false,
    }
    connections.set(syncId, conn)
    connect(syncId, conn)
  }
  return conn
}

// useSyncExternalStore calls getSnapshot on every render (and once synchronously before
// subscribe ever runs), so a late-joining subscriber picks up whatever the connection
// already knows for free — no separate "hydrate the new listener" step needed.
function getSnapshot(syncId: number): StreamState {
  return connections.get(syncId)?.state ?? EMPTY_STATE
}

function subscribe(syncId: number, onStoreChange: () => void): () => void {
  const conn = getConnection(syncId)
  conn.listeners.add(onStoreChange)
  return () => {
    conn.listeners.delete(onStoreChange)
    if (conn.listeners.size === 0) {
      conn.closed = true
      clearTimeout(conn.reconnectTimer)
      conn.es?.close()
      connections.delete(syncId)
    }
  }
}

export function useSyncStream(syncId: number | null): SyncStreamResult {
  const subscribeFn = (onStoreChange: () => void) => {
    if (syncId === null) return () => {}
    return subscribe(syncId, onStoreChange)
  }

  const getSnapshotFn = () =>
    syncId === null ? EMPTY_STATE : getSnapshot(syncId)

  return useSyncExternalStore(subscribeFn, getSnapshotFn)
}
