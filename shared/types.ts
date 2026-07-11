// Shared API types — imported by both backend (Deno) and frontend (Vite).
// No runtime code, no framework imports: pure TypeScript type definitions only.

// --- Auth ---

export interface AuthStatus {
  configured: boolean;
  source: "env" | "db" | null;
  reachable?: boolean;
  reason?: "token_revoked";
  // Best-effort — omitted if the plex.tv account lookup failed or hasn't been configured.
  user?: { username: string; thumb: string | null };
}

export interface PlexPin {
  pinId: number;
  code: string;
  authUrl: string;
}

export interface PlexConnection {
  uri: string;
  local: boolean;
  relay: boolean;
}

export interface PlexServer {
  name: string;
  accessToken: string;
  machineIdentifier: string;
  connections: PlexConnection[];
}

export type PinPollResult =
  | { status: "pending" }
  | { status: "complete"; servers: PlexServer[] };

// --- Settings ---

export interface Settings {
  staleMinAgeDays: number;
  inactiveUserDays: number;
  ipHistoryRetentionDays: number;
}

// --- Libraries ---

export interface Library {
  key: string;
  title: string;
  type: string;
  syncedAt: number;
  // Null until this library's cross-user play-history backfill has completed at least
  // once for the current sync attempt. While null, any item's lastViewedAt === null in
  // this library cannot be trusted to mean "never watched" — it may just be unsynced.
  historySyncedAt: number | null;
  staleMinAgeDays: number | null;
  itemCount: number;
  // Decimal KB, matching StaleItem.fileSize — see formatKilobytes in frontend/src/lib/format.ts.
  totalFileSize: number;
}

export interface LibrariesResponse {
  limit: number;
  offset: number;
  total: number;
  libraries: Library[];
}

// --- Items ---

export interface StaleItem {
  ratingKey: string;
  libraryKey: string;
  title: string;
  type: string;
  thumb: string | null;
  addedAt: number | null;
  lastViewedAt: number | null;
  viewCount: number | null;
  fileSize: number | null;
  duration: number | null;
  year: number | null;
  updatedAt: number;
  // Only populated by GET /:key/stale, and only when length >= 2 — this item's
  // fileSize is then a combined total across multiple synced Plex Media versions (see
  // Duplicate detection in CLAUDE.md). Undefined on StaleItem-shaped fields elsewhere
  // (show/movie detail) and on single-version items. Movies only.
  versions?: MediaVersion[];
  // Only populated by GET /:key/stale for show items, and only when true — at least
  // one of this show's episodes has multiple synced Plex Media versions. No per-episode
  // detail is carried here (unlike `versions`); see the global /api/duplicates
  // endpoint's episode groups for that.
  hasDuplicateEpisodes?: boolean;
}

export interface StaleResponse {
  days: number;
  maxDays: number | null;
  minAgeDays: number;
  libraryStaleMinAgeDays: number | null;
  historySyncedAt: number | null;
  filter: string;
  sort: string;
  order: string;
  duplicatesOnly: boolean;
  limit: number;
  offset: number;
  total: number;
  items: StaleItem[];
}

// --- Seasons / Show detail ---

export interface Season {
  ratingKey: string;
  showRatingKey: string;
  libraryKey: string;
  seasonIndex: number;
  title: string;
  fileSize: number | null;
  duration: number | null;
  leafCount: number | null;
  viewCount: number | null;
  updatedAt: number;
}

export interface ShowDetail {
  show: StaleItem;
  seasons: Season[];
  historySyncedAt: number | null;
}

// --- Movie detail ---

export interface MovieDetail {
  movie: StaleItem;
  historySyncedAt: number | null;
}

// --- Duplicate / multi-version detection ---
// Plex groups multiple video files for the same movie under one item as separate
// Media entries (e.g. a 1080p rip and a 4K remux) — these types surface that grouping
// independent of watch/stale status, since Plex only tracks lastViewedAt/viewCount per
// item, never per Media version, so which version was watched is never knowable.

export interface MediaVersion {
  mediaId: number;
  videoResolution: string | null;
  bitrate: number | null;
  videoCodec: string | null;
  container: string | null;
  fileSize: number | null;
}

export interface DuplicateMovieGroup {
  mediaType: "movie";
  libraryKey: string;
  ratingKey: string;
  title: string;
  year: number | null;
  thumb: string | null;
  combinedFileSize: number | null;
  versions: MediaVersion[];
}

export interface DuplicateEpisodeGroup {
  mediaType: "episode";
  libraryKey: string;
  episodeRatingKey: string;
  showRatingKey: string;
  showTitle: string;
  showThumb: string | null;
  seasonIndex: number;
  episodeIndex: number;
  episodeTitle: string;
  combinedFileSize: number | null;
  versions: MediaVersion[];
}

export type DuplicateGroup = DuplicateMovieGroup | DuplicateEpisodeGroup;

export interface DuplicatesResponse {
  limit: number;
  offset: number;
  total: number;
  groups: DuplicateGroup[];
}

export interface DeleteMediaVersionResponse {
  fileSizeFreed: number;
}

// --- Users (inactive-user and account-sharing review) ---
// Surfaces who has access to the server and how active they are — including revoking
// a user's access via DELETE /api/users/:accountId (see RemoveUserResponse below).
// lastViewedAt is null both for a genuine never-watched user and for one not yet
// reconciled by a sync — see usersSyncedAt below.

export interface PlexUser {
  accountId: number;
  username: string;
  email: string | null;
  thumb: string | null;
  isOwner: boolean;
  lastViewedAt: number | null;
  sharingRisk: SharingRiskAssessment;
}

export type SharingDataConfidence = 'none' | 'low' | 'medium' | 'high';
export type SharingRiskLevel = 'insufficient_data' | 'low' | 'watch' | 'review';
export type SharingRiskSignalType =
  | 'remote_network_diversity'
  | 'remote_device_diversity'
  | 'rapid_network_switching';

export interface SharingRiskSignal {
  type: SharingRiskSignalType;
  weight: number;
  summary: string;
}

export interface SharingRiskAssessment {
  // Deterministic review score, not a probability that sharing occurred.
  riskScore: number;
  riskLevel: SharingRiskLevel;
  dataConfidence: SharingDataConfidence;
  observationCount: number;
  activeDays: number;
  observationSpanDays: number;
  observedSince: number | null;
  signals: SharingRiskSignal[];
}

export interface UsersResponse {
  // Null until the roster has synced at least once for the current server — while
  // null, this list may be incomplete or stale, same contract as Library.historySyncedAt.
  usersSyncedAt: number | null;
  inactiveDays: number;
  limit: number;
  offset: number;
  total: number;
  users: PlexUser[];
}

export interface RemoveUserResponse {
  accountId: number;
  username: string;
}

// --- Item deletion ---

export interface DeleteItemsRequest {
  ratingKeys: string[];
}

export interface DeleteItemsResponse {
  deleted: string[];
  failed: { ratingKey: string; error: string }[];
}

// --- Sync ---

export type LibraryPhase =
  | "pending"
  | "items"
  | "episodes"
  | "tracks"
  | "history"
  | "done";

export interface LibrarySyncProgress {
  key: string;
  title: string;
  phase: LibraryPhase;
  count: number;
  elapsedSeconds?: number; // set when phase === 'done'
}

export interface SyncLog {
  id: number;
  libraryKey: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: "pending" | "success" | "error";
  itemsProcessed: number | null;
  error: string | null;
  progress?: LibrarySyncProgress[]; // only present while status === 'pending'
}

export interface SyncTriggerResponse {
  syncId: number;
  status: "pending";
}

// --- Activity log ---

export type EventType =
  | "sync.completed"
  | "sync.failed"
  | "items.deleted"
  | "media.deleted"
  | "user.removed";

export interface SyncCompletedPayload {
  syncId: number;
  libraryKey: string | null;
  itemsProcessed: number;
}

export interface SyncFailedPayload {
  syncId: number;
  libraryKey: string | null;
  error: string;
}

export interface ItemsDeletedPayload {
  libraryKey: string;
  deletedCount: number;
  failedCount: number;
  // Decimal KB, matching Library.totalFileSize / StaleItem.fileSize — see formatKilobytes
  // in frontend/src/lib/format.ts.
  fileSizeFreed: number;
}

// A single duplicate-version delete's payload — deliberately self-contained (carries
// `title`, not just `ratingKey`) like ItemsDeletedPayload, so the activity feed never
// needs a lookup to render a readable line for an event that already happened.
export interface MediaDeletedPayload {
  libraryKey: string;
  ratingKey: string;
  title: string;
  mediaId: number;
  // Decimal KB, matching ItemsDeletedPayload.fileSizeFreed.
  fileSizeFreed: number;
}

// Self-contained like MediaDeletedPayload (carries username, not just accountId) so the
// activity feed never needs a lookup to render a readable line for a user who, by the
// time the feed renders, may no longer exist in the users table at all.
export interface UserRemovedPayload {
  accountId: number;
  username: string;
}

export type ActivityEvent =
  | {
    id: number;
    type: "sync.completed";
    payload: SyncCompletedPayload | null;
    createdAt: number;
  }
  | {
    id: number;
    type: "sync.failed";
    payload: SyncFailedPayload | null;
    createdAt: number;
  }
  | {
    id: number;
    type: "items.deleted";
    payload: ItemsDeletedPayload | null;
    createdAt: number;
  }
  | {
    id: number;
    type: "media.deleted";
    payload: MediaDeletedPayload | null;
    createdAt: number;
  }
  | {
    id: number;
    type: "user.removed";
    payload: UserRemovedPayload | null;
    createdAt: number;
  };

export interface ActivityEventsResponse {
  limit: number;
  events: ActivityEvent[];
  // Pass as `before` on the next request to page further back; null once there's no more history.
  nextCursor: number | null;
}
