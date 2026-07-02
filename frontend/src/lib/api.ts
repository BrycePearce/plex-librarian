import type { QueryClient } from '@tanstack/react-query'
import type {
  AuthStatus,
  PlexPin,
  PinPollResult,
  Library,
  LibrariesResponse,
  StaleResponse,
  ShowDetail,
  Settings,
  SyncLog,
  SyncTriggerResponse,
} from '@shared/types'

export type {
  AuthStatus,
  PlexPin,
  PinPollResult,
  PlexConnection,
  PlexServer,
  Library,
  LibrariesResponse,
  StaleItem,
  StaleResponse,
  Season,
  ShowDetail,
  Settings,
  SyncLog,
  SyncTriggerResponse,
  LibraryPhase,
  LibrarySyncProgress,
} from '@shared/types'

// Frontend-only types (not part of the API contract)
export type SortKey = 'fileSize' | 'lastViewedAt' | 'addedAt' | 'title' | 'year' | 'viewCount'

export interface StaleParams {
  days?: number
  maxDays?: number
  minAgeDays?: number
  filter?: 'all' | 'watched' | 'unwatched'
  sort?: SortKey
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

// --- Fetch client ---

const BASE = '/api'

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    const message = body.error ?? res.statusText
    throw new Error(message.charAt(0).toUpperCase() + message.slice(1))
  }
  return res.json() as Promise<T>
}

export const api = {
  auth: {
    status: () =>
      apiFetch<AuthStatus>('/auth/status'),
    createPin: () =>
      apiFetch<PlexPin>('/auth/plex/pin', { method: 'POST' }),
    pollPin: (id: number) =>
      apiFetch<PinPollResult>(`/auth/plex/pin/${id}`),
    chooseServer: (
      serverUrl: string,
      accessToken: string,
      machineIdentifier: string,
      name: string,
    ) =>
      apiFetch<{ ok: true }>('/auth/plex/server', {
        method: 'POST',
        body: JSON.stringify({ serverUrl, accessToken, machineIdentifier, name }),
      }),
    disconnect: () =>
      apiFetch<{ ok: true }>('/auth/plex', { method: 'DELETE' }),
  },
  libraries: {
    list: (limit = 100, offset = 0) =>
      apiFetch<LibrariesResponse>(`/libraries?limit=${limit}&offset=${offset}`),
    stale: (key: string, params: StaleParams = {}) => {
      const q = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) q.set(k, String(v))
      }
      return apiFetch<StaleResponse>(`/libraries/${encodeURIComponent(key)}/stale?${q}`)
    },
    showDetail: (key: string, ratingKey: string) =>
      apiFetch<ShowDetail>(`/libraries/${encodeURIComponent(key)}/shows/${encodeURIComponent(ratingKey)}`),
    updateStaleMinAgeDays: (key: string, staleMinAgeDays: number | null) =>
      apiFetch<Library>(`/libraries/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        body: JSON.stringify({ staleMinAgeDays }),
      }),
  },
  settings: {
    get: () =>
      apiFetch<Settings>('/settings'),
    update: (staleMinAgeDays: number) =>
      apiFetch<Settings>('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ staleMinAgeDays }),
      }),
  },
  sync: {
    trigger: () =>
      apiFetch<SyncTriggerResponse>('/sync', { method: 'POST' }),
    triggerLibrary: (key: string) =>
      apiFetch<SyncTriggerResponse>(`/sync/libraries/${encodeURIComponent(key)}`, { method: 'POST' }),
    poll: (id: number) =>
      apiFetch<SyncLog>(`/sync/${id}`),
    history: (limit = 20) =>
      apiFetch<SyncLog[]>(`/sync/history?limit=${limit}`),
  },
}

// Connecting, switching, or disconnecting the active server points every server-scoped
// query — libraries, sync history, stale lists, show detail — at a different dataset.
// Without a full invalidation, react-query's default staleTime keeps serving whatever
// the previously-active server's data was cached as until it happens to expire.
export function invalidateServerScopedQueries(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries()
}
