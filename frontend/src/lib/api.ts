import type { QueryClient } from "@tanstack/react-query";
import type {
  ActivityEventsResponse,
  ArrInstance,
  ArrIntegrationSettings,
  AuthStatus,
  CancelPendingInvitationResponse,
  DeleteItemsResponse,
  DeleteMediaVersionResponse,
  DuplicatesResponse,
  LibrariesResponse,
  Library,
  MovieDetail,
  PendingInvitationsResponse,
  PinPollResult,
  PlexPin,
  RemoveUserResponse,
  SaveArrInstanceRequest,
  Settings,
  ShowDetail,
  StaleResponse,
  SyncLog,
  SyncTriggerResponse,
  UsersResponse,
} from "@shared/types";

export type {
  ActivityEvent,
  ActivityEventsResponse,
  ArrInstance,
  ArrIntegrationSettings,
  ArrLibraryMapping,
  ArrType,
  AuthStatus,
  CancelPendingInvitationResponse,
  DeleteItemsResponse,
  DeleteMediaVersionResponse,
  DuplicateEpisodeGroup,
  DuplicateGroup,
  DuplicateMovieGroup,
  DuplicatesResponse,
  EventType,
  LibrariesResponse,
  Library,
  LibraryPhase,
  LibrarySyncProgress,
  MediaVersion,
  MovieDetail,
  PendingInvitation,
  PendingInvitationsResponse,
  PinPollResult,
  PlexConnection,
  PlexPin,
  PlexServer,
  PlexUser,
  RemoveUserResponse,
  Season,
  Settings,
  ShowDetail,
  StaleItem,
  StaleResponse,
  SyncLog,
  SyncTriggerResponse,
  UsersResponse,
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
    const body = await res.json().catch(() => ({ error: res.statusText })) as {
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
      serverUrl: string,
      accessToken: string,
      machineIdentifier: string,
      name: string,
    ) =>
      apiFetch<{ ok: true }>("/auth/plex/server", {
        method: "POST",
        body: JSON.stringify({
          serverUrl,
          accessToken,
          machineIdentifier,
          name,
        }),
      }),
    disconnect: () =>
      apiFetch<{ ok: true }>("/auth/plex", { method: "DELETE" }),
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
          encodeURIComponent(ratingKey)
        }`,
      ),
    movieDetail: (key: string, ratingKey: string) =>
      apiFetch<MovieDetail>(
        `/libraries/${encodeURIComponent(key)}/movies/${
          encodeURIComponent(ratingKey)
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
      mode: "coordinated" | "plex-only" = "coordinated",
    ) =>
      apiFetch<DeleteItemsResponse>(
        `/libraries/${encodeURIComponent(key)}/items`,
        {
          method: "DELETE",
          body: JSON.stringify({ ratingKeys, mode }),
        },
      ),
  },
  duplicates: {
    list: (
      params: {
        type?: "movie" | "tv" | "all";
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
      apiFetch<DeleteMediaVersionResponse>(
        `/duplicates/movies/${encodeURIComponent(ratingKey)}/media/${mediaId}`,
        { method: "DELETE" },
      ),
    deleteEpisodeMediaVersion: (episodeRatingKey: string, mediaId: number) =>
      apiFetch<DeleteMediaVersionResponse>(
        `/duplicates/episodes/${
          encodeURIComponent(episodeRatingKey)
        }/media/${mediaId}`,
        { method: "DELETE" },
      ),
  },
  settings: {
    get: () => apiFetch<Settings>("/settings"),
    // Only the keys present in `partial` are validated/changed server-side — see
    // routes/settings.ts — so the independent Settings inputs can each
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
    history: (limit = 20) =>
      apiFetch<SyncLog[]>(`/sync/history?limit=${limit}`),
  },
  events: {
    list: (params: { limit?: number; before?: number } = {}) => {
      const q = new URLSearchParams();
      if (params.limit !== undefined) q.set("limit", String(params.limit));
      if (params.before !== undefined) q.set("before", String(params.before));
      return apiFetch<ActivityEventsResponse>(`/events?${q}`);
    },
  },
};

// Connecting, switching, or disconnecting the active server points every server-scoped
// query — libraries, sync history, stale lists, show detail, activity events — at a
// different dataset. `invalidateQueries` alone marks them stale and refetches in the
// background, but still renders whatever the previously-active server's data was cached
// as in the meantime — on a client-side nav (no full page reload) straight to /dashboard
// right after this, that means the *old* server's populated library grid flashes on
// screen before the new server's fresh (often empty, first-sync) data lands.
// `resetQueries` clears the cached data back to unfetched instead, so anything reading it
// renders a genuine loading state rather than stale content — but only for these roots.
// An unfiltered `resetQueries()` would reset every query in the app (e.g. `['auth',
// 'status']`, which callers usually just refetched a line earlier), forcing pointless
// extra fetches and a visible flash back to loading state for data that has nothing to
// do with the active server.
const SERVER_SCOPED_QUERY_ROOTS = [
  "libraries",
  "sync",
  "stale",
  "show",
  "duplicates",
  "events",
  "users",
  "arr-integrations",
];

export function invalidateServerScopedQueries(qc: QueryClient): Promise<void> {
  return qc.resetQueries({
    predicate: (query) =>
      SERVER_SCOPED_QUERY_ROOTS.includes(query.queryKey[0] as string),
  });
}
