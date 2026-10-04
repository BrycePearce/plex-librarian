// Query keys are part of the cache contract: every reader and invalidator must agree
// on them. Keep their string roots and common key shapes in this one registry.
const roots = {
  auth: "auth",
  historicalDownloadAccess: "historical-download-access",
  libraries: "libraries",
  sync: "sync",
  stale: "stale",
  show: "show",
  movie: "movie",
  duplicates: "duplicates",
  users: "users",
  events: "events",
  settings: "settings",
  mediaRemovals: "media-removals",
  arrIntegrations: "arr-integrations",
  qbittorrentIntegrations: "qbittorrent-integrations",
  seerrIntegrations: "seerr-integrations",
  integrationCompatibility: "integration-compatibility",
  deletionOperations: "deletion-operations",
  episodeGaps: "episode-gaps",
} as const;

export const queryKeys = {
  historicalDownloadAccess: { all: [roots.historicalDownloadAccess] as const },
  auth: {
    all: [roots.auth] as const,
    status: [roots.auth, "status"] as const,
    configuration: [roots.auth, "configuration"] as const,
    pin: (pinId: number | null) => [roots.auth, "pin", pinId] as const,
  },
  libraries: {
    all: [roots.libraries] as const,
    arrSettings: [roots.libraries, "arr-settings"] as const,
  },
  sync: {
    all: [roots.sync] as const,
    history: [roots.sync, "history"] as const,
    latestSuccess: [roots.sync, "latest-success"] as const,
  },
  stale: {
    all: [roots.stale] as const,
    library: (libraryKey: string) => [roots.stale, libraryKey] as const,
    list: <TParams>(libraryKey: string, params: TParams) =>
      [roots.stale, libraryKey, params] as const,
  },
  show: {
    all: [roots.show] as const,
    detail: (libraryKey: string, ratingKey: string) => [roots.show, libraryKey, ratingKey] as const,
  },
  movie: {
    all: [roots.movie] as const,
    detail: (libraryKey: string, ratingKey: string) =>
      [roots.movie, libraryKey, ratingKey] as const,
  },
  duplicates: {
    all: [roots.duplicates] as const,
    lists: [roots.duplicates, "list"] as const,
    list: <TParams>(params: TParams) => [roots.duplicates, "list", params] as const,
    technicalRefresh: (mediaType: "movie" | "episode", ratingKey: string) =>
      [roots.duplicates, "technical-refresh", mediaType, ratingKey] as const,
    // Selection-only analysis omits service evidence and must never share cached
    // results with the full review, even for the same season and episode keys.
    seasonSelectionAnalysis: (
      seasonRatingKey: string | undefined,
      episodeRatingKeys: readonly string[],
    ) =>
      [roots.duplicates, "season-selection-analysis", seasonRatingKey, episodeRatingKeys] as const,
  },
  users: {
    all: [roots.users] as const,
    list: <TParams>(params: TParams) => [roots.users, params] as const,
    invitations: [roots.users, "invitations"] as const,
    invitationList: <TParams>(params: TParams) => [roots.users, "invitations", params] as const,
    requestFollowThrough: (accountId: number | null) =>
      [roots.users, "request-follow-through", accountId] as const,
    sharingRiskTrend: (accountId: number | null) =>
      [roots.users, "sharing-risk-trend", accountId] as const,
  },
  events: { all: [roots.events] as const },
  settings: {
    all: [roots.settings] as const,
    plexPathMappings: [roots.settings, "plex-path-mappings"] as const,
    ignoredContent: [roots.settings, "ignored-content"] as const,
    ignoredContentSearch: (query: string) =>
      [roots.settings, "ignored-content", "search", query] as const,
  },
  mediaRemovals: {
    all: [roots.mediaRemovals] as const,
    summary: [roots.mediaRemovals, "summary"] as const,
  },
  arrIntegrations: { all: [roots.arrIntegrations] as const },
  qbittorrentIntegrations: {
    all: [roots.qbittorrentIntegrations] as const,
  },
  seerrIntegrations: { all: [roots.seerrIntegrations] as const },
  integrationCompatibility: { all: [roots.integrationCompatibility] as const },
  deletionOperations: {
    all: [roots.deletionOperations] as const,
    lists: [roots.deletionOperations, "list"] as const,
    list: <TParams>(params: TParams) => [roots.deletionOperations, "list", params] as const,
    detail: (id: string) => [roots.deletionOperations, id] as const,
    arrLinks: (id: string) => [roots.deletionOperations, id, "arr-links"] as const,
  },
  episodeGaps: {
    all: [roots.episodeGaps] as const,
    list: <TParams>(params: TParams) => [roots.episodeGaps, params] as const,
  },
} as const;

type QueryRootName = keyof typeof roots;
type QueryRootPolicy =
  | { serverScoped: false; syncDerived: false }
  | { serverScoped: true; syncDerived: boolean };

// `satisfies` makes cache lifecycle classification exhaustive: adding a root above is a
// type error until its scope is declared here. Auth and app settings are installation-
// wide. Removal history and qBittorrent configuration are server-scoped, but a Plex
// sync cannot change them.
const rootPolicies = {
  historicalDownloadAccess: { serverScoped: true, syncDerived: true },
  auth: { serverScoped: false, syncDerived: false },
  libraries: { serverScoped: true, syncDerived: true },
  sync: { serverScoped: true, syncDerived: true },
  stale: { serverScoped: true, syncDerived: true },
  show: { serverScoped: true, syncDerived: true },
  movie: { serverScoped: true, syncDerived: true },
  duplicates: { serverScoped: true, syncDerived: true },
  users: { serverScoped: true, syncDerived: true },
  events: { serverScoped: true, syncDerived: true },
  settings: { serverScoped: true, syncDerived: false },
  mediaRemovals: { serverScoped: true, syncDerived: false },
  arrIntegrations: { serverScoped: true, syncDerived: true },
  qbittorrentIntegrations: { serverScoped: true, syncDerived: false },
  seerrIntegrations: { serverScoped: true, syncDerived: false },
  integrationCompatibility: { serverScoped: true, syncDerived: false },
  deletionOperations: { serverScoped: true, syncDerived: false },
  episodeGaps: { serverScoped: true, syncDerived: true },
} satisfies Record<QueryRootName, QueryRootPolicy>;

const rootNames = Object.keys(roots) as QueryRootName[];

export const serverScopedQueryRoots = rootNames
  .filter((name) => rootPolicies[name].serverScoped)
  .map((name) => roots[name]);

export const syncDerivedQueryRoots = rootNames
  .filter((name) => rootPolicies[name].syncDerived)
  .map((name) => roots[name]);
