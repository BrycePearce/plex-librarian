// Shared API types — imported by both backend (Deno) and frontend (Vite).
// No runtime code, no framework imports: pure TypeScript type definitions only.

// --- Auth ---

export interface AuthStatus {
  configured: boolean
  source: 'env' | 'db' | null
  reachable?: boolean
  reason?: 'token_revoked'
}

export interface PlexPin {
  pinId: number
  code: string
  authUrl: string
}

export interface PlexConnection {
  uri: string
  local: boolean
  relay: boolean
}

export interface PlexServer {
  name: string
  accessToken: string
  connections: PlexConnection[]
}

export type PinPollResult =
  | { status: 'pending' }
  | { status: 'complete'; servers: PlexServer[] }

// --- Libraries ---

export interface Library {
  key: string
  title: string
  type: string
  syncedAt: number
}

export interface LibrariesResponse {
  limit: number
  offset: number
  total: number
  libraries: Library[]
}

// --- Items ---

export interface StaleItem {
  ratingKey: string
  libraryKey: string
  title: string
  type: string
  thumb: string | null
  addedAt: number | null
  lastViewedAt: number | null
  viewCount: number | null
  fileSize: number | null
  duration: number | null
  year: number | null
  updatedAt: number
}

export interface StaleResponse {
  days: number
  maxDays: number | null
  minAgeDays: number
  filter: string
  sort: string
  order: string
  limit: number
  offset: number
  total: number
  items: StaleItem[]
}

// --- Seasons / Show detail ---

export interface Season {
  ratingKey: string
  showRatingKey: string
  libraryKey: string
  seasonIndex: number
  title: string
  fileSize: number | null
  duration: number | null
  leafCount: number | null
  viewCount: number | null
  updatedAt: number
}

export interface ShowDetail {
  show: StaleItem
  seasons: Season[]
}

// --- Sync ---

export interface SyncLog {
  id: number
  libraryKey: string | null
  startedAt: number
  finishedAt: number | null
  status: 'pending' | 'success' | 'error'
  itemsProcessed: number | null
  error: string | null
}

export interface SyncTriggerResponse {
  syncId: number
  status: 'pending'
}
