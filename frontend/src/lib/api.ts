import type {
  ActivityEventsResponse,
  ArrInstance,
  ArrIntegrationSettings,
  AuthStatus,
  CancelPendingInvitationResponse,
  DeletionOperation,
  DeletionOperationCreated,
  DeletionOperationsResponse,
  DownloadCleanupPreviewResponse,
  DuplicatesResponse,
  FinishRelocationResponse,
  LibrariesResponse,
  Library,
  MediaRemovalSummary,
  MediaVersionsRefreshResponse,
  MovieDetail,
  PendingInvitationsResponse,
  PinPollResult,
  PlexPathMapping,
  PlexPin,
  QbittorrentInstance,
  QbittorrentIntegrationSettings,
  RemoveUserResponse,
  RequestFollowThroughDetailsResponse,
  SaveArrInstanceRequest,
  SavePlexPathMappingRequest,
  SaveQbittorrentInstanceRequest,
  SaveSeerrInstanceRequest,
  SeerrInstance,
  SeerrIntegrationSettings,
  Settings,
  ShowDetail,
  SmartDuplicateAnalysisResponse,
  SmartDuplicateCleanupResponse,
  StaleQuickCleanupOrder,
  StaleQuickCleanupResponse,
  StaleQuickCleanupSort,
  StaleResponse,
  SyncLog,
  SyncTriggerResponse,
  UpdateArrInstanceRequest,
  UpdateQbittorrentInstanceRequest,
  UpdateSeerrInstanceRequest,
  UsersActivityFilter,
  UsersResponse,
  UsersRiskFilter,
  UsersSortKey,
  VersionDeletionPreviewResponse,
} from "@shared/types";
import type { DuplicateComparisonFilter } from "@shared/mediaComparison";
import { v4 as uuidv4 } from "uuid";

export type {
  ActivityEvent,
  ActivityEventsResponse,
  ArrCleanupFile,
  ArrCleanupTarget,
  ArrInstance,
  ArrIntegrationSettings,
  ArrLibraryMapping,
  ArrType,
  AuthStatus,
  CancelPendingInvitationResponse,
  DeleteItemsResponse,
  DeletionOperation,
  DeletionOperationCreated,
  DeletionOperationListItem,
  DeletionOperationsResponse,
  DownloadCleanupJob,
  DownloadCleanupPreviewItem,
  DownloadCleanupPreviewResponse,
  DuplicateEpisodeGroup,
  DuplicateGroup,
  DuplicateMovieGroup,
  DuplicatesResponse,
  EventType,
  LibrariesResponse,
  Library,
  LibraryPhase,
  LibrarySyncProgress,
  MediaRemovalSummary,
  MediaVersion,
  MediaVersionPathPreview,
  MovieDetail,
  PendingInvitation,
  PendingInvitationsResponse,
  PinPollResult,
  PlexConnection,
  PlexPin,
  PlexServer,
  PlexUser,
  QbittorrentInstance,
  QbittorrentIntegrationSettings,
  RemoveUserResponse,
  RequestFollowThroughDetailItem,
  RequestFollowThroughDetailsResponse,
  Season,
  SeerrInstance,
  SeerrIntegrationSettings,
  Settings,
  ShowDetail,
  SmartDuplicateAnalysisResponse,
  SmartDuplicateCandidate,
  SmartDuplicateCleanupResponse,
  StaleItem,
  StaleQuickCleanupCandidate,
  StaleQuickCleanupOrder,
  StaleQuickCleanupResponse,
  StaleQuickCleanupSort,
  StaleResponse,
  SyncLog,
  SyncTriggerResponse,
  UsersActivityFilter,
  UsersResponse,
  UsersRiskFilter,
  UsersSortKey,
  VersionDeletionPreviewResponse,
} from "@shared/types";

// Frontend-only types (not part of the API contract)
export type SortKey = "fileSize" | "lastViewedAt" | "addedAt" | "title" | "year" | "viewCount";

export interface StaleParams {
  days?: number;
  maxDays?: number;
  minAgeDays?: number;
  search?: string;
  filter?: "all" | "watched" | "unwatched";
  duplicatesOnly?: boolean;
  sort?: SortKey;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
  count?: boolean;
}

export interface UsersParams {
  search?: string;
  filter?: UsersActivityFilter;
  inactiveDays?: number;
  risk?: UsersRiskFilter;
  sort?: UsersSortKey;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

// --- Fetch client ---

const BASE = "/api";

// Carries the HTTP status alongside the message so callers can distinguish, e.g., a 404
// for "this row doesn't exist yet" (a legitimate not-yet-synced state) from a real failure.
export class ApiError extends Error {
  status: number;
  operationId?: string;

  constructor(status: number, message: string, operationId?: string) {
    super(message);
    this.status = status;
    this.operationId = operationId;
  }
}

export function isNotFoundError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 404;
}

export function deletionOperationIdFromError(err: unknown): string | null {
  return err instanceof ApiError &&
      typeof err.operationId === "string" &&
      err.operationId.length > 0
    ? err.operationId
    : null;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as {
      error?: string;
      operationId?: unknown;
    };
    const message = body.error ?? res.statusText;
    const operationId = typeof body.operationId === "string" && body.operationId.length > 0
      ? body.operationId
      : undefined;
    throw new ApiError(res.status, message.charAt(0).toUpperCase() + message.slice(1), operationId);
  }
  return res.json() as Promise<T>;
}

export const api = {
  auth: {
    status: () => apiFetch<AuthStatus>("/auth/status"),
    createPin: () => apiFetch<PlexPin>("/auth/plex/pin", { method: "POST" }),
    pollPin: (id: number) => apiFetch<PinPollResult>(`/auth/plex/pin/${id}`),
    chooseServer: (
      serverUrls: string[],
      accessToken: string,
      machineIdentifier: string,
      name: string,
    ) =>
      apiFetch<{ ok: true }>("/auth/plex/server", {
        method: "POST",
        body: JSON.stringify({
          serverUrls,
          accessToken,
          machineIdentifier,
          name,
        }),
      }),
    disconnect: () => apiFetch<{ ok: true }>("/auth/plex", { method: "DELETE" }),
  },
  libraries: {
    list: (limit = 100, offset = 0) =>
      apiFetch<LibrariesResponse>(`/libraries?limit=${limit}&offset=${offset}`),
    listAll: async () => {
      const pageSize = 1000;
      const libraries: Library[] = [];
      let total = 0;

      do {
        const page = await apiFetch<LibrariesResponse>(
          `/libraries?limit=${pageSize}&offset=${libraries.length}`,
        );
        total = page.total;
        libraries.push(...page.libraries);
        if (page.libraries.length === 0) break;
      } while (libraries.length < total);

      return {
        limit: libraries.length,
        offset: 0,
        total,
        libraries,
      } satisfies LibrariesResponse;
    },
    stale: (key: string, params: StaleParams = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) q.set(k, String(v));
      }
      return apiFetch<StaleResponse>(`/libraries/${encodeURIComponent(key)}/stale?${q}`);
    },
    staleQuickCleanup: (
      key: string,
      days: number,
      sort: StaleQuickCleanupSort,
      order: StaleQuickCleanupOrder,
    ) =>
      apiFetch<StaleQuickCleanupResponse>(
        `/libraries/${
          encodeURIComponent(
            key,
          )
        }/stale/quick-cleanup?days=${days}&sort=${sort}&order=${order}`,
      ),
    showDetail: (key: string, ratingKey: string) =>
      apiFetch<ShowDetail>(
        `/libraries/${encodeURIComponent(key)}/shows/${encodeURIComponent(ratingKey)}`,
      ),
    movieDetail: (key: string, ratingKey: string) =>
      apiFetch<MovieDetail>(
        `/libraries/${encodeURIComponent(key)}/movies/${encodeURIComponent(ratingKey)}`,
      ),
    updateStaleMinAgeDays: (key: string, staleMinAgeDays: number | null) =>
      apiFetch<Library>(`/libraries/${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: JSON.stringify({ staleMinAgeDays }),
      }),
    deleteItems: (
      key: string,
      ratingKeys: string[],
      coordinatedRatingKeys: string[],
      cleanupDownloads = false,
      unmonitorRatingKeys: string[] = [],
      quickCleanupThresholdDays?: number,
    ) =>
      apiFetch<DeletionOperationCreated>(`/libraries/${encodeURIComponent(key)}/items`, {
        method: "DELETE",
        body: JSON.stringify({
          clientRequestId: uuidv4(),
          ratingKeys,
          coordinatedRatingKeys,
          cleanupDownloads,
          unmonitorRatingKeys,
          quickCleanupThresholdDays,
        }),
      }),
    downloadCleanupPreview: (key: string, ratingKeys: string[]) =>
      apiFetch<DownloadCleanupPreviewResponse>(
        `/libraries/${encodeURIComponent(key)}/items/download-cleanup-preview`,
        { method: "POST", body: JSON.stringify({ ratingKeys }) },
      ),
  },
  duplicates: {
    list: (
      params: {
        type?: "movie" | "tv" | "all";
        comparison?: DuplicateComparisonFilter;
        search?: string;
        limit?: number;
        offset?: number;
      } = {},
    ) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) q.set(k, String(v));
      }
      return apiFetch<DuplicatesResponse>(`/duplicates?${q}`);
    },
    smartAnalysis: (options: { movies: boolean; tv: boolean }) =>
      apiFetch<SmartDuplicateAnalysisResponse>("/duplicates/smart-analysis", {
        method: "POST",
        body: JSON.stringify(options),
      }),
    smartCleanup: (
      clientRequestId: string,
      selections: Array<{
        mediaType: "movie" | "episode";
        ratingKey: string;
        deleteMediaIds: number[];
      }>,
      includeNearIdentical: boolean,
    ) =>
      apiFetch<SmartDuplicateCleanupResponse>("/duplicates/smart-cleanup", {
        method: "POST",
        body: JSON.stringify({
          clientRequestId,
          selections,
          includeNearIdentical,
        }),
      }),
    deleteMovieMediaVersion: (ratingKey: string, mediaId: number) =>
      apiFetch<DeletionOperationCreated>(
        `/duplicates/movies/${encodeURIComponent(ratingKey)}/media/${mediaId}`,
        {
          method: "DELETE",
          body: JSON.stringify({ clientRequestId: uuidv4() }),
        },
      ),
    versionDeletionPreview: (
      mediaType: "movie" | "episode",
      ratingKey: string,
      mediaIds: number[],
      inspectDownloadCleanup = false,
    ) =>
      apiFetch<VersionDeletionPreviewResponse>(
        `/duplicates/${mediaType === "movie" ? "movies" : "episodes"}/${
          encodeURIComponent(
            ratingKey,
          )
        }/media/deletion-preview`,
        {
          method: "POST",
          body: JSON.stringify({ mediaIds, inspectDownloadCleanup }),
        },
      ),
    deleteMovieMediaVersions: (
      ratingKey: string,
      mediaIds: number[],
      cleanupMediaIds: number[],
      radarrDecision?: {
        planFingerprint?: string;
        allowRadarrRetainedPathManagement?: boolean;
        allowRadarrMovieRemoval?: boolean;
      },
    ) =>
      apiFetch<DeletionOperationCreated>(
        `/duplicates/movies/${encodeURIComponent(ratingKey)}/media`,
        {
          method: "DELETE",
          body: JSON.stringify({
            clientRequestId: uuidv4(),
            mediaIds,
            cleanupMediaIds,
            ...radarrDecision,
          }),
        },
      ),
    deleteEpisodeMediaVersion: (episodeRatingKey: string, mediaId: number) =>
      apiFetch<DeletionOperationCreated>(
        `/duplicates/episodes/${encodeURIComponent(episodeRatingKey)}/media/${mediaId}`,
        {
          method: "DELETE",
          body: JSON.stringify({ clientRequestId: uuidv4() }),
        },
      ),
    deleteEpisodeMediaVersions: (episodeRatingKey: string, mediaIds: number[]) =>
      apiFetch<DeletionOperationCreated>(
        `/duplicates/episodes/${encodeURIComponent(episodeRatingKey)}/media`,
        {
          method: "DELETE",
          body: JSON.stringify({
            clientRequestId: uuidv4(),
            mediaIds,
          }),
        },
      ),
    refreshTechnicalDetails: (mediaType: "movie" | "episode", ratingKey: string) =>
      apiFetch<MediaVersionsRefreshResponse>(
        `/duplicates/${mediaType === "movie" ? "movies" : "episodes"}/${
          encodeURIComponent(
            ratingKey,
          )
        }/media/technical-refresh`,
        { method: "POST" },
      ),
  },
  deletionOperations: {
    list: (
      params: {
        status?:
          | "queued"
          | "running"
          | "waiting_retry"
          | "completed"
          | "completed_with_warning"
          | "needs_attention"
          | "cancelled";
        attention?: boolean;
        limit?: number;
        offset?: number;
      } = {},
    ) => {
      const q = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) q.set(key, String(value));
      }
      return apiFetch<DeletionOperationsResponse>(`/deletion-operations?${q}`);
    },
    get: (id: string) =>
      apiFetch<DeletionOperation>(`/deletion-operations/${encodeURIComponent(id)}`),
    cancel: (id: string) =>
      apiFetch<DeletionOperation>(`/deletion-operations/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      }),
    retry: (id: string, outcome: "needs_attention" | "warning" | "all" = "all") =>
      apiFetch<DeletionOperation>(`/deletion-operations/${encodeURIComponent(id)}/retry`, {
        method: "POST",
        body: JSON.stringify({ outcome }),
      }),
    dismiss: (id: string) =>
      apiFetch<DeletionOperation>(`/deletion-operations/${encodeURIComponent(id)}/dismiss`, {
        method: "POST",
        body: JSON.stringify({ acknowledge: true }),
      }),
    resolve: (id: string) =>
      apiFetch<{
        resolution: "resumed" | "cancelled";
        operation: DeletionOperation;
      }>(`/deletion-operations/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
      }),
    finishRelocation: (
      id: string,
      targetId: number,
      guidanceId: string,
      destinationPlaybackConfirmed: boolean,
    ) =>
      apiFetch<FinishRelocationResponse>(
        `/deletion-operations/${encodeURIComponent(id)}/targets/${targetId}/finish-relocation`,
        {
          method: "POST",
          body: JSON.stringify({ guidanceId, destinationPlaybackConfirmed }),
        },
      ),
    runRelocationSync: (id: string, targetId: number) =>
      apiFetch<FinishRelocationResponse>(
        `/deletion-operations/${encodeURIComponent(id)}/targets/${targetId}/relocation-sync`,
        { method: "POST" },
      ),
  },
  settings: {
    get: () => apiFetch<Settings>("/settings"),
    // Only the keys present in `partial` are validated/changed server-side — see
    // features/settings/route.ts — so the independent Settings inputs can each
    // save independently without clobbering the other's value.
    update: (partial: Partial<Settings>) =>
      apiFetch<Settings>("/settings", {
        method: "PATCH",
        body: JSON.stringify(partial),
      }),
    plexPathMappings: () => apiFetch<PlexPathMapping[]>("/settings/plex-path-mappings"),
    createPlexPathMapping: (mapping: SavePlexPathMappingRequest) =>
      apiFetch<{ id: number; revision: number }>("/settings/plex-path-mappings", {
        method: "POST",
        body: JSON.stringify(mapping),
      }),
    deletePlexPathMapping: (id: number) =>
      apiFetch<void>(`/settings/plex-path-mappings/${id}`, {
        method: "DELETE",
      }),
  },
  arr: {
    get: () => apiFetch<ArrIntegrationSettings>("/integrations/arr"),
    createInstance: (instance: SaveArrInstanceRequest) =>
      apiFetch<ArrInstance>("/integrations/arr/instances", {
        method: "POST",
        body: JSON.stringify(instance),
      }),
    updateInstance: (id: number, instance: UpdateArrInstanceRequest) =>
      apiFetch<ArrInstance>(`/integrations/arr/instances/${id}`, {
        method: "PATCH",
        body: JSON.stringify(instance),
      }),
    testInstance: (id: number) =>
      apiFetch<{ version: string | null }>(`/integrations/arr/instances/${id}/test`, {
        method: "POST",
      }),
    deleteInstance: (id: number) =>
      apiFetch<{ ok: true }>(`/integrations/arr/instances/${id}`, {
        method: "DELETE",
      }),
    saveLibraryMapping: (libraryKey: string, instanceIds: number[], addImportExclusion: boolean) =>
      apiFetch<{ ok: true }>(`/integrations/arr/libraries/${encodeURIComponent(libraryKey)}`, {
        method: "PUT",
        body: JSON.stringify({ instanceIds, addImportExclusion }),
      }),
  },
  qbittorrent: {
    get: () => apiFetch<QbittorrentIntegrationSettings>("/integrations/qbittorrent"),
    createInstance: (instance: SaveQbittorrentInstanceRequest) =>
      apiFetch<QbittorrentInstance>("/integrations/qbittorrent/instances", {
        method: "POST",
        body: JSON.stringify(instance),
      }),
    updateInstance: (id: number, instance: UpdateQbittorrentInstanceRequest) =>
      apiFetch<QbittorrentInstance>(`/integrations/qbittorrent/instances/${id}`, {
        method: "PATCH",
        body: JSON.stringify(instance),
      }),
    testInstance: (id: number) =>
      apiFetch<{ version: string }>(`/integrations/qbittorrent/instances/${id}/test`, {
        method: "POST",
      }),
    deleteInstance: (id: number) =>
      apiFetch<{ ok: true }>(`/integrations/qbittorrent/instances/${id}`, {
        method: "DELETE",
      }),
  },
  seerr: {
    get: () => apiFetch<SeerrIntegrationSettings>("/integrations/seerr"),
    createInstance: (instance: SaveSeerrInstanceRequest) =>
      apiFetch<SeerrInstance>("/integrations/seerr/instances", {
        method: "POST",
        body: JSON.stringify(instance),
      }),
    updateInstance: (id: number, instance: UpdateSeerrInstanceRequest) =>
      apiFetch<SeerrInstance>(`/integrations/seerr/instances/${id}`, {
        method: "PATCH",
        body: JSON.stringify(instance),
      }),
    testInstance: (id: number) =>
      apiFetch<{ version: string | null }>(`/integrations/seerr/instances/${id}/test`, {
        method: "POST",
      }),
    deleteInstance: (id: number) =>
      apiFetch<{ ok: true }>(`/integrations/seerr/instances/${id}`, {
        method: "DELETE",
      }),
  },
  users: {
    invitations: (
      params: {
        filter?: "all" | "attention" | "current" | "stale" | "critical";
        search?: string;
        sort?: "createdAt" | "username" | "libraryCount";
        order?: "asc" | "desc";
        limit?: number;
        offset?: number;
      } = {},
    ) => {
      const q = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") q.set(key, String(value));
      }
      const query = q.toString();
      return apiFetch<PendingInvitationsResponse>(`/users/invitations${query ? `?${query}` : ""}`);
    },
    cancelInvitation: (inviteId: number) =>
      apiFetch<CancelPendingInvitationResponse>(`/users/invitations/${inviteId}`, {
        method: "DELETE",
      }),
    list: (params: UsersParams = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) q.set(k, String(v));
      }
      const qs = q.toString();
      return apiFetch<UsersResponse>(`/users${qs ? `?${qs}` : ""}`);
    },
    requestFollowThrough: (accountId: number, limit = 200) =>
      apiFetch<RequestFollowThroughDetailsResponse>(
        `/users/${accountId}/request-follow-through?limit=${limit}`,
      ),
    remove: (accountId: number) =>
      apiFetch<RemoveUserResponse>(`/users/${accountId}`, { method: "DELETE" }),
  },
  sync: {
    trigger: () => apiFetch<SyncTriggerResponse>("/sync", { method: "POST" }),
    triggerLibrary: (key: string) =>
      apiFetch<SyncTriggerResponse>(`/sync/libraries/${encodeURIComponent(key)}`, {
        method: "POST",
      }),
    poll: (id: number) => apiFetch<SyncLog>(`/sync/${id}`),
    history: (limit = 20) => apiFetch<SyncLog[]>(`/sync/history?limit=${limit}`),
    latestSuccess: () => apiFetch<{ finishedAt: number | null }>("/sync/latest-success"),
  },
  events: {
    list: (params: { limit?: number; before?: number } = {}) => {
      const q = new URLSearchParams();
      if (params.limit !== undefined) q.set("limit", String(params.limit));
      if (params.before !== undefined) q.set("before", String(params.before));
      return apiFetch<ActivityEventsResponse>(`/events?${q}`);
    },
  },
  mediaRemovals: {
    summary: () => apiFetch<MediaRemovalSummary>("/media-removals/summary"),
  },
};
