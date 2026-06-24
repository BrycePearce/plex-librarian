import type {
  AuthStatus,
  PlexPin,
  PinPollResult,
  LibrariesResponse,
  StaleResponse,
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
  SyncLog,
  SyncTriggerResponse,
} from '@shared/types'

// Frontend-only types (not part of the API contract)
export type SortKey = 'fileSize' | 'lastViewedAt' | 'addedAt' | 'title' | 'year'

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
    throw new Error(body.error ?? res.statusText)
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
    chooseServer: (serverUrl: string, accessToken: string) =>
      apiFetch<{ ok: true }>('/auth/plex/server', {
        method: 'POST',
        body: JSON.stringify({ serverUrl, accessToken }),
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
  },
  sync: {
    trigger: () =>
      apiFetch<SyncTriggerResponse>('/sync', { method: 'POST' }),
    poll: (id: number) =>
      apiFetch<SyncLog>(`/sync/${id}`),
    history: (limit = 20) =>
      apiFetch<SyncLog[]>(`/sync/history?limit=${limit}`),
  },
}
