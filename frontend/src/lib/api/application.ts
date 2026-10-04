import { apiFetch } from "./client.ts";
import type {
  ActivityEventsResponse,
  AuthStatus,
  CancelPendingInvitationResponse,
  EpisodeGapsParams,
  EpisodeGapsResponse,
  IgnoredContentItem,
  IgnoredContentResponse,
  MediaRemovalSummary,
  PendingInvitationsResponse,
  PinPollResult,
  PlexPathMapping,
  PlexPin,
  RemoveUserResponse,
  RequestFollowThroughDetailsResponse,
  SavePlexPathMappingRequest,
  Settings,
  SharingRiskTrendResponse,
  SyncLog,
  SyncTriggerResponse,
  UsersResponse,
} from "@shared/types";
import type { UsersParams } from "./types.ts";

export const authApi = {
  configuration: () => apiFetch<AuthStatus>("/auth/status?validate=false"),
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
};

export const toolsApi = {
  episodeGaps: (params: EpisodeGapsParams = {}) => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") q.set(key, String(value));
    }
    return apiFetch<EpisodeGapsResponse>(`/tools/episode-gaps?${q}`);
  },
};

export const settingsApi = {
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
  updatePlexPathMapping: (id: number, mapping: SavePlexPathMappingRequest) =>
    apiFetch<PlexPathMapping>(`/settings/plex-path-mappings/${id}`, {
      method: "PUT",
      body: JSON.stringify(mapping),
    }),
  createPlexPathMapping: (mapping: SavePlexPathMappingRequest) =>
    apiFetch<{ id: number; revision: number }>("/settings/plex-path-mappings", {
      method: "POST",
      body: JSON.stringify(mapping),
    }),
  ignoredContent: () => apiFetch<IgnoredContentResponse>("/settings/ignored-content"),
  searchIgnoredContent: (query: string) =>
    apiFetch<IgnoredContentResponse>(
      `/settings/ignored-content/search?q=${encodeURIComponent(query)}`,
    ),
  addIgnoredContent: (ratingKey: string) =>
    apiFetch<IgnoredContentItem>("/settings/ignored-content", {
      method: "POST",
      body: JSON.stringify({ ratingKey }),
    }),
  removeIgnoredContent: (ratingKey: string) =>
    apiFetch<void>(`/settings/ignored-content/${encodeURIComponent(ratingKey)}`, {
      method: "DELETE",
    }),
};

export const usersApi = {
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
  sharingRiskTrend: (accountId: number) =>
    apiFetch<SharingRiskTrendResponse>(`/users/${accountId}/sharing-risk-trend`),
  remove: (accountId: number) =>
    apiFetch<RemoveUserResponse>(`/users/${accountId}`, { method: "DELETE" }),
};

export const syncApi = {
  trigger: () => apiFetch<SyncTriggerResponse>("/sync", { method: "POST" }),
  triggerLibrary: (key: string) =>
    apiFetch<SyncTriggerResponse>(`/sync/libraries/${encodeURIComponent(key)}`, {
      method: "POST",
    }),
  poll: (id: number) => apiFetch<SyncLog>(`/sync/${id}`),
  history: (limit = 20) => apiFetch<SyncLog[]>(`/sync/history?limit=${limit}`),
  latestSuccess: () => apiFetch<{ finishedAt: number | null }>("/sync/latest-success"),
};

export const eventsApi = {
  list: (params: { limit?: number; before?: number; excludeDurableDeletions?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.before !== undefined) q.set("before", String(params.before));
    if (params.excludeDurableDeletions) q.set("excludeDurableDeletions", "true");
    return apiFetch<ActivityEventsResponse>(`/events?${q}`);
  },
};

export const mediaRemovalsApi = {
  summary: () => apiFetch<MediaRemovalSummary>("/media-removals/summary"),
};
