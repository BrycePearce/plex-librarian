import type {
  ActivityEventsResponse,
  ArrInstance,
  ArrIntegrationSettings,
  AuthStatus,
  CancelPendingInvitationResponse,
  DeletionOperation,
  DeletionOperationCreated,
  DownloadCleanupPreviewResponse,
  DuplicatesResponse,
  LibrariesResponse,
  Library,
  MediaRemovalSummary,
  MediaVersionsRefreshResponse,
  MovieDetail,
  PendingInvitationsResponse,
  PinPollResult,
  PlexPin,
  QbittorrentInstance,
  QbittorrentIntegrationSettings,
  RemoveUserResponse,
  SaveArrInstanceRequest,
  SaveQbittorrentInstanceRequest,
  SaveSeerrInstanceRequest,
  SeerrInstance,
  SeerrIntegrationSettings,
  Settings,
  ShowDetail,
  StaleResponse,
  SyncLog,
  SyncTriggerResponse,
  UpdateArrInstanceRequest,
  UpdateQbittorrentInstanceRequest,
  UpdateSeerrInstanceRequest,
  UsersResponse,
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
  Season,
  SeerrInstance,
  SeerrIntegrationSettings,
  Settings,
  ShowDetail,
  StaleItem,
  StaleResponse,
  SyncLog,
  SyncTriggerResponse,
  UsersResponse,
  VersionDeletionPreviewResponse,
} from "@shared/types";

// Frontend-only types (not part of the API contract)
export type SortKey =
  | "fileSize"
  | "lastViewedAt"
  | "addedAt"
  | "title"
  | "year"
  | "viewCount";

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
}

// --- Fetch client ---

const BASE = "/api";

// Carries the HTTP status alongside the message so callers can distinguish, e.g., a 404
// for "this row doesn't exist yet" (a legitimate not-yet-synced state) from a real failure.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isNotFoundError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 404;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = (await res
      .json()
      .catch(() => ({ error: res.statusText }))) as {
        error?: string;
      };
    const message = body.error ?? res.statusText;
    throw new ApiError(
      res.status,
      message.charAt(0).toUpperCase() + message.slice(1),
    );
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
      return apiFetch<StaleResponse>(
        `/libraries/${encodeURIComponent(key)}/stale?${q}`,
      );
    },
    showDetail: (key: string, ratingKey: string) =>
      apiFetch<ShowDetail>(
        `/libraries/${encodeURIComponent(key)}/shows/${
          encodeURIComponent(
            ratingKey,
          )
        }`,
      ),
    movieDetail: (key: string, ratingKey: string) =>
      apiFetch<MovieDetail>(
        `/libraries/${encodeURIComponent(key)}/movies/${
          encodeURIComponent(
            ratingKey,
          )
        }`,
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
    ) =>
      apiFetch<DeletionOperationCreated>(
        `/libraries/${encodeURIComponent(key)}/items`,
        {
          method: "DELETE",
          body: JSON.stringify({
            clientRequestId: uuidv4(),
            ratingKeys,
            coordinatedRatingKeys,
            cleanupDownloads,
            unmonitorRatingKeys,
          }),
        },
      ),
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
    ) =>
      apiFetch<VersionDeletionPreviewResponse>(
        `/duplicates/${mediaType === "movie" ? "movies" : "episodes"}/${
          encodeURIComponent(ratingKey)
        }/media/deletion-preview`,
        { method: "POST", body: JSON.stringify({ mediaIds }) },
      ),
    deleteMovieMediaVersions: (
      ratingKey: string,
      mediaIds: number[],
      arrMediaIds: number[],
      cleanupMediaIds: number[],
      unmonitorFromArr: boolean,
    ) =>
      apiFetch<DeletionOperationCreated>(
        `/duplicates/movies/${encodeURIComponent(ratingKey)}/media`,
        {
          method: "DELETE",
          body: JSON.stringify({
            clientRequestId: uuidv4(),
            mediaIds,
            arrMediaIds,
            cleanupMediaIds,
            unmonitorFromArr,
          }),
        },
      ),
    deleteEpisodeMediaVersion: (episodeRatingKey: string, mediaId: number) =>
      apiFetch<DeletionOperationCreated>(
        `/duplicates/episodes/${
          encodeURIComponent(
            episodeRatingKey,
          )
        }/media/${mediaId}`,
        {
          method: "DELETE",
          body: JSON.stringify({ clientRequestId: uuidv4() }),
        },
      ),
    deleteEpisodeMediaVersions: (
      episodeRatingKey: string,
      mediaIds: number[],
      unmonitorFromArr: boolean,
    ) =>
      apiFetch<DeletionOperationCreated>(
        `/duplicates/episodes/${encodeURIComponent(episodeRatingKey)}/media`,
        {
          method: "DELETE",
          body: JSON.stringify({
            clientRequestId: uuidv4(),
            mediaIds,
            unmonitorFromArr,
          }),
        },
      ),
    refreshTechnicalDetails: (
      mediaType: "movie" | "episode",
      ratingKey: string,
    ) =>
      apiFetch<MediaVersionsRefreshResponse>(
        `/duplicates/${mediaType === "movie" ? "movies" : "episodes"}/${
          encodeURIComponent(ratingKey)
        }/media/technical-refresh`,
        { method: "POST" },
      ),
  },
  deletionOperations: {
    get: (id: string) =>
      apiFetch<DeletionOperation>(
        `/deletion-operations/${encodeURIComponent(id)}`,
      ),
    cancel: (id: string) =>
      apiFetch<DeletionOperation>(
        `/deletion-operations/${encodeURIComponent(id)}/cancel`,
        { method: "POST" },
      ),
    retry: (id: string) =>
      apiFetch<DeletionOperation>(
        `/deletion-operations/${encodeURIComponent(id)}/retry`,
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
      apiFetch<{ version: string | null }>(
        `/integrations/arr/instances/${id}/test`,
        { method: "POST" },
      ),
    deleteInstance: (id: number) =>
      apiFetch<{ ok: true }>(`/integrations/arr/instances/${id}`, {
        method: "DELETE",
      }),
    saveLibraryMapping: (
      libraryKey: string,
      instanceIds: number[],
      addImportExclusion: boolean,
    ) =>
      apiFetch<{ ok: true }>(
        `/integrations/arr/libraries/${encodeURIComponent(libraryKey)}`,
        {
          method: "PUT",
          body: JSON.stringify({ instanceIds, addImportExclusion }),
        },
      ),
  },
  qbittorrent: {
    get: () => apiFetch<QbittorrentIntegrationSettings>("/integrations/qbittorrent"),
    createInstance: (instance: SaveQbittorrentInstanceRequest) =>
      apiFetch<QbittorrentInstance>("/integrations/qbittorrent/instances", {
        method: "POST",
        body: JSON.stringify(instance),
      }),
    updateInstance: (id: number, instance: UpdateQbittorrentInstanceRequest) =>
      apiFetch<QbittorrentInstance>(
        `/integrations/qbittorrent/instances/${id}`,
        { method: "PATCH", body: JSON.stringify(instance) },
      ),
    testInstance: (id: number) =>
      apiFetch<{ version: string }>(
        `/integrations/qbittorrent/instances/${id}/test`,
        { method: "POST" },
      ),
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
      apiFetch<{ version: string | null }>(
        `/integrations/seerr/instances/${id}/test`,
        { method: "POST" },
      ),
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
      return apiFetch<PendingInvitationsResponse>(
        `/users/invitations${query ? `?${query}` : ""}`,
      );
    },
    cancelInvitation: (inviteId: number) =>
      apiFetch<CancelPendingInvitationResponse>(
        `/users/invitations/${inviteId}`,
        {
          method: "DELETE",
        },
      ),
    list: (
      params: {
        inactiveDays?: number;
        search?: string;
        filter?: "all" | "inactive" | "never" | "unknown";
        risk?:
          | "all"
          | "attention"
          | "review"
          | "watch"
          | "low"
          | "insufficient_data";
        sort?: "lastViewedAt" | "username" | "sharingRisk";
        order?: "asc" | "desc";
        limit?: number;
        offset?: number;
      } = {},
    ) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) q.set(k, String(v));
      }
      const qs = q.toString();
      return apiFetch<UsersResponse>(`/users${qs ? `?${qs}` : ""}`);
    },
    remove: (accountId: number) =>
      apiFetch<RemoveUserResponse>(`/users/${accountId}`, { method: "DELETE" }),
  },
  sync: {
    trigger: () => apiFetch<SyncTriggerResponse>("/sync", { method: "POST" }),
    triggerLibrary: (key: string) =>
      apiFetch<SyncTriggerResponse>(
        `/sync/libraries/${encodeURIComponent(key)}`,
        { method: "POST" },
      ),
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
