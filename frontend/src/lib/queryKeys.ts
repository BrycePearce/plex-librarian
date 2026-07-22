// Query keys are part of the cache contract: every reader and invalidator must agree
// on them. Keep their string roots and common key shapes in this one registry.
const roots = {
  auth: "auth",
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
  downloadCleanupPreview: "download-cleanup-preview",
  versionDeletionPreview: "version-deletion-preview",
  deletionOperations: "deletion-operations",
} as const;

export const queryKeys = {
  auth: {
    all: [roots.auth] as const,
    status: [roots.auth, "status"] as const,
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
  },
  users: {
    all: [roots.users] as const,
    list: <TParams>(params: TParams) => [roots.users, params] as const,
    invitations: [roots.users, "invitations"] as const,
    invitationList: <TParams>(params: TParams) => [roots.users, "invitations", params] as const,
  },
  events: { all: [roots.events] as const },
  settings: { all: [roots.settings] as const },
  mediaRemovals: {
    all: [roots.mediaRemovals] as const,
    summary: [roots.mediaRemovals, "summary"] as const,
  },
  arrIntegrations: { all: [roots.arrIntegrations] as const },
  qbittorrentIntegrations: {
    all: [roots.qbittorrentIntegrations] as const,
  },
  seerrIntegrations: { all: [roots.seerrIntegrations] as const },
  downloadCleanupPreview: {
    all: [roots.downloadCleanupPreview] as const,
    forItems: (libraryKey: string, ratingKeys: readonly string[]) =>
      [roots.downloadCleanupPreview, libraryKey, ratingKeys] as const,
  },
  versionDeletionPreview: {
    all: [roots.versionDeletionPreview] as const,
    forVersions: (
      mediaType: "movie" | "episode" | undefined,
      ratingKey: string,
      mediaIds: readonly number[],
    ) => [roots.versionDeletionPreview, mediaType, ratingKey, mediaIds] as const,
  },
  deletionOperations: {
    all: [roots.deletionOperations] as const,
    detail: (id: string) => [roots.deletionOperations, id] as const,
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
  auth: { serverScoped: false, syncDerived: false },
  libraries: { serverScoped: true, syncDerived: true },
  sync: { serverScoped: true, syncDerived: true },
  stale: { serverScoped: true, syncDerived: true },
  show: { serverScoped: true, syncDerived: true },
  movie: { serverScoped: true, syncDerived: true },
  duplicates: { serverScoped: true, syncDerived: true },
  users: { serverScoped: true, syncDerived: true },
  events: { serverScoped: true, syncDerived: true },
  settings: { serverScoped: false, syncDerived: false },
  mediaRemovals: { serverScoped: true, syncDerived: false },
  arrIntegrations: { serverScoped: true, syncDerived: true },
  qbittorrentIntegrations: { serverScoped: true, syncDerived: false },
  seerrIntegrations: { serverScoped: true, syncDerived: false },
  downloadCleanupPreview: { serverScoped: true, syncDerived: true },
  versionDeletionPreview: { serverScoped: true, syncDerived: true },
  deletionOperations: { serverScoped: true, syncDerived: false },
} satisfies Record<QueryRootName, QueryRootPolicy>;

const rootNames = Object.keys(roots) as QueryRootName[];

export const serverScopedQueryRoots = rootNames
  .filter((name) => rootPolicies[name].serverScoped)
  .map((name) => roots[name]);

export const syncDerivedQueryRoots = rootNames
  .filter((name) => rootPolicies[name].syncDerived)
  .map((name) => roots[name]);
