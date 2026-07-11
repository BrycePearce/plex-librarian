import { foreignKey, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// One row per distinct Plex Media Server ever connected, keyed by Plex's stable
// per-install machineIdentifier. All synced data is scoped to a server row via
// serverId so switching servers can never merge or overwrite another server's data —
// see settings.activeServerId.
export const servers = sqliteTable('servers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  machineIdentifier: text('machine_identifier').notNull().unique(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  accessToken: text('access_token').notNull(),
  lastConnectedAt: integer('last_connected_at').notNull(),
  // Set only when the current roster-sync attempt (syncUsers) has completed for this
  // server — reset to null the moment a new attempt starts, same contract as
  // libraries.historySyncedAt. Null means the `users` table cannot yet be trusted to
  // reflect who currently has access.
  usersSyncedAt: integer('users_synced_at'),
});

export const libraries = sqliteTable(
  'libraries',
  {
    serverId: integer('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    title: text('title').notNull(),
    type: text('type').notNull(),
    syncedAt: integer('synced_at').notNull(),
    // Set only when this library's cross-user play-history backfill (syncLibraryHistory)
    // has completed for the CURRENT sync attempt — reset to null the moment a new attempt
    // starts, so an interrupted sync can never be mistaken for complete data. Null means
    // lastViewedAt for this library's items cannot yet be trusted to mean "never watched";
    // it may just mean "history hasn't finished syncing." See CLAUDE.md.
    historySyncedAt: integer('history_synced_at'),
    staleMinAgeDays: integer('stale_min_age_days'), // null = use settings.staleMinAgeDays
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.key] }),
  }),
);

export const items = sqliteTable(
  'items',
  {
    serverId: integer('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    ratingKey: text('rating_key').notNull(),
    libraryKey: text('library_key').notNull(),
    title: text('title').notNull(),
    type: text('type').notNull(),
    thumb: text('thumb'),
    addedAt: integer('added_at'),
    lastViewedAt: integer('last_viewed_at'),
    viewCount: integer('view_count').default(0),
    fileSize: integer('file_size'),
    duration: integer('duration'),
    year: integer('year'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.ratingKey] }),
    libraryFk: foreignKey({
      columns: [table.serverId, table.libraryKey],
      foreignColumns: [libraries.serverId, libraries.key],
    }).onDelete('cascade'),
    lastViewedAtIdx: index('items_last_viewed_at_idx').on(table.serverId, table.lastViewedAt),
    libraryStaleIdx: index('items_library_stale_idx').on(
      table.serverId,
      table.libraryKey,
      table.lastViewedAt,
    ),
    libraryFileSizeIdx: index('items_library_file_size_idx').on(
      table.serverId,
      table.libraryKey,
      table.fileSize,
    ),
  }),
);

// Singleton row (id = 1) — app-wide behavior settings and installation identity.
// Per-server Plex credentials live on `servers`; activeServerId points at the one
// currently synced/displayed. Env vars PLEX_URL + PLEX_TOKEN take precedence over
// the active server's stored credentials at runtime.
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  clientId: text('client_id').notNull(),
  publicJwk: text('public_jwk'),
  privateJwk: text('private_jwk'),
  activeServerId: integer('active_server_id').references(() => servers.id),
  autoSyncEnabled: integer('auto_sync_enabled', { mode: 'boolean' }).default(true),
  autoSyncHour: integer('auto_sync_hour').default(3), // 0–23 local server time; default 3am
  staleMinAgeDays: integer('stale_min_age_days').notNull().default(90),
  // Deliberately a separate column from staleMinAgeDays rather than reused — media
  // staleness and user inactivity are different concepts that happen to share a "days"
  // shape. Used by GET /api/users' default `filter=inactive` threshold.
  inactiveUserDays: integer('inactive_user_days').notNull().default(30),
  // Global retention for per-user IP transitions and playback observations. Zero
  // disables automatic pruning.
  ipHistoryRetentionDays: integer('ip_history_retention_days').notNull().default(365),
});

// One row per Plex account with access to a server (owner + friends/Home members
// actually shared to that server, per plex.tv's shared_servers listing) — the roster,
// refreshed by syncUsers() on every full sync. Deliberately keyed by the GLOBAL
// plex.tv account id (`accountId`), not the PMS-local account id: the global id is the
// only identifier guaranteed to exist for a user who has access but has never
// connected/watched anything, which is exactly the "never watched" case this feature
// exists to surface. Empirically verified (see plan) that these two id spaces are
// genuinely different — e.g. the server owner is always local id 1 on the PMS's own
// /accounts endpoint, but has a distinct, much larger global plex.tv account id.
//
// Webhook payloads (Account.id) and /status/sessions/history/all entries (accountID)
// both report the PMS-LOCAL id, not the global one, so they can't be joined against
// `accountId` directly. `localAccountId` bridges the gap: syncUsers() reconciles it by
// matching username against the PMS's own /accounts endpoint. It's nullable and starts
// out unset for a user who has access but has never actually connected to the PMS
// (Plex doesn't allocate them a local id until they do) — activity writes fall back to
// a username match to self-heal that mapping the first time such a user is ever seen
// (see webhook.ts and syncLibraryHistory).
export const users = sqliteTable(
  'users',
  {
    serverId: integer('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    accountId: integer('account_id').notNull(),
    localAccountId: integer('local_account_id'),
    username: text('username').notNull(),
    email: text('email'),
    thumb: text('thumb'),
    isOwner: integer('is_owner', { mode: 'boolean' }).notNull().default(false),
    // null = never watched anything on this server, or roster/reconciliation hasn't
    // run yet for this account. Maintained as a running max (like items.lastViewedAt)
    // rather than derived at query time from the bounded userPlayObservations table.
    lastViewedAt: integer('last_viewed_at'),
    // Webhook-only (Player.publicAddress) — never backfilled by history sync, which
    // doesn't carry IP. Unavailable entirely on non-Plex-Pass installs.
    lastIp: text('last_ip'),
    // Webhook-only (Player.title — the device/player name, e.g. "LG 50UN6950ZUF" or
    // "Chrome") — same availability caveat as lastIp. Written unconditionally on every
    // matched event, not scrobble-gated, matching lastViewedAt/lastIp's "most recent"
    // semantics rather than totalPlays/totalDuration's "count of real plays" semantics.
    lastPlayer: text('last_player'),
    // Both bumped ONLY on media.scrobble (Plex's own "this counts as a real play"
    // signal, fired at 90% watched), not media.play — mirrors items.viewCount's
    // existing scrobble-only gating in webhook.ts, so a play that's started but
    // abandoned doesn't inflate either counter. totalDuration is stored in
    // milliseconds, matching items.duration's raw-from-Plex convention (frontend
    // divides by 1000 before formatting) — summed from Metadata.duration per scrobble,
    // an approximation ("this play counted as one full watch-through") rather than
    // actual elapsed playback time, which Plex doesn't report.
    totalPlays: integer('total_plays').notNull().default(0),
    totalDuration: integer('total_duration').notNull().default(0),
    // Plex includes the authoritative lastViewedAt value on scrobble payloads. Keep
    // the latest value so duplicate/retried webhook deliveries cannot increment the
    // aggregate counters more than once.
    lastScrobbledAt: integer('last_scrobbled_at'),
    // Plex's own id for this specific friend/server share — NOT accountId (global
    // plex.tv id), NOT servers.id (this app's row), NOT machineIdentifier. It's the
    // `id` attribute on the per-user <Server> element nested inside the /api/users
    // friends XML (see plexUsers.ts's parseFriendsXml). Required to revoke just this
    // server's access via DELETE /api/servers/{machineIdentifier}/shared_servers/{id}
    // — the per-server-scoped removal endpoint, not the "unfriend everywhere" one.
    // Always null for the owner row (nothing to revoke); should be non-null for every
    // other row once a roster sync has run, since roster membership itself already
    // requires a matching <Server> entry to exist.
    sharedServerId: integer('shared_server_id'),
    // Bumped ONLY by syncUsers()' roster upsert — webhook/history writes to
    // lastViewedAt/lastIp/lastPlayer/totalPlays/totalDuration/localAccountId must never
    // touch this column. It's what the
    // post-sync prune (`WHERE updated_at < now`) uses to drop users no longer in the
    // roster; letting activity writes refresh it would let a departed user's stray
    // in-flight webhook event keep them from ever being pruned.
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.accountId] }),
    lastViewedAtIdx: index('users_last_viewed_at_idx').on(table.serverId, table.lastViewedAt),
    localAccountIdx: index('users_local_account_idx').on(table.serverId, table.localAccountId),
  }),
);

// One row per IP transition for an account, not one row per play event. `viewedAt`
// records when the transition began and `lastSeenAt` is refreshed while the same IP
// remains current. That preserves the recency needed by a future account-sharing
// detector without growing this table for every play. The hourly scheduler applies the
// administrator's retention setting. There is deliberately no FK to
// users: roster membership is mutable, but the collected history must survive access
// removal and re-addition. The server FK still removes all history with its server.
export const userIpHistory = sqliteTable(
  'user_ip_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: integer('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    accountId: integer('account_id').notNull(),
    ip: text('ip').notNull(),
    viewedAt: integer('viewed_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (table) => ({
    accountIdx: index('user_ip_history_account_idx').on(
      table.serverId,
      table.accountId,
      table.viewedAt,
    ),
    lastSeenIdx: index('user_ip_history_last_seen_idx').on(table.lastSeenAt),
  }),
);

// One bounded row per accepted user playback webhook. Unlike userIpHistory, this
// deliberately preserves repeated observations from the same IP so a future
// account-sharing detector can correlate simultaneous activity, device churn, and
// local/remote playback. It contains only the player/network fields needed for that
// analysis—no media titles or library metadata. There is deliberately no FK to users:
// observations survive roster removal/re-addition until the retention window expires.
export const userPlayObservations = sqliteTable(
  'user_play_observations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: integer('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    accountId: integer('account_id').notNull(),
    observedAt: integer('observed_at').notNull(),
    event: text('event').notNull(),
    ip: text('ip'),
    // Normalized /24 (IPv4) or /64 (IPv6) used for diversity scoring.
    networkKey: text('network_key'),
    playerUuid: text('player_uuid'),
    playerTitle: text('player_title'),
    isLocal: integer('is_local', { mode: 'boolean' }),
  },
  (table) => ({
    accountObservedIdx: index('user_play_observations_account_observed_idx').on(
      table.serverId,
      table.accountId,
      table.observedAt,
    ),
    observedAtIdx: index('user_play_observations_observed_at_idx').on(table.observedAt),
    playerIdx: index('user_play_observations_player_idx').on(
      table.serverId,
      table.accountId,
      table.playerUuid,
    ),
  }),
);

export const seasons = sqliteTable(
  'seasons',
  {
    serverId: integer('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    ratingKey: text('rating_key').notNull(),
    showRatingKey: text('show_rating_key').notNull(),
    libraryKey: text('library_key').notNull(),
    seasonIndex: integer('season_index').notNull(),
    title: text('title').notNull(),
    fileSize: integer('file_size'),
    duration: integer('duration'),
    leafCount: integer('leaf_count'),
    viewCount: integer('view_count').default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.ratingKey] }),
    showFk: foreignKey({
      columns: [table.serverId, table.showRatingKey],
      foreignColumns: [items.serverId, items.ratingKey],
    }).onDelete('cascade'),
    libraryFk: foreignKey({
      columns: [table.serverId, table.libraryKey],
      foreignColumns: [libraries.serverId, libraries.key],
    }).onDelete('cascade'),
    showIdx: index('seasons_show_idx').on(table.serverId, table.showRatingKey),
    libraryIdx: index('seasons_library_idx').on(table.serverId, table.libraryKey),
  }),
);

// One row per Plex `Media` entry on a movie item — captures the individual file
// versions Plex groups under one ratingKey (e.g. a 1080p rip and a 4K remux of the
// same movie) so they can be surfaced as a "duplicate" group and deleted individually.
// Keyed by Plex's own per-Media `id`, which — like ratingKey — is already unique per
// server, so this mirrors `seasons`' PK shape (own Plex id, not a compound key through
// the parent). TV/artist libraries never populate this table: TV syncs at show
// granularity (see CLAUDE.md) and per-episode multi-version detection is out of scope.
export const itemMediaVersions = sqliteTable(
  'item_media_versions',
  {
    serverId: integer('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    mediaId: integer('media_id').notNull(),
    itemRatingKey: text('item_rating_key').notNull(),
    libraryKey: text('library_key').notNull(),
    videoResolution: text('video_resolution'),
    bitrate: integer('bitrate'),
    videoCodec: text('video_codec'),
    container: text('container'),
    fileSize: integer('file_size'), // decimal KB, same convention as items.fileSize
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.mediaId] }),
    itemFk: foreignKey({
      columns: [table.serverId, table.itemRatingKey],
      foreignColumns: [items.serverId, items.ratingKey],
    }).onDelete('cascade'),
    libraryFk: foreignKey({
      columns: [table.serverId, table.libraryKey],
      foreignColumns: [libraries.serverId, libraries.key],
    }).onDelete('cascade'),
    itemIdx: index('item_media_versions_item_idx').on(table.serverId, table.itemRatingKey),
    libraryIdx: index('item_media_versions_library_idx').on(table.serverId, table.libraryKey),
  }),
);

// One row per Plex `Media` entry on an episode — but ONLY for episodes that already
// have 2+ valid (id != null) Media entries. Deliberately asymmetric with
// itemMediaVersions, which stores one row per movie unconditionally: movies already
// get exactly 1 row per movie in `items` regardless of duplicate status, so 1 row per
// movie there is proportional to what's already stored. Episodes have no such
// baseline — they are never stored as individual rows anywhere (see CLAUDE.md's Scale
// assumptions) — so storing one row per episode unconditionally would scale with total
// episode count across every TV library on the server, which is exactly what this app
// avoids elsewhere. Filtering to genuine duplicates only at WRITE time
// (mapEpisodeMediaVersions in lib/plex.ts) keeps this table's size bounded by actual
// duplicate-episode count, not library size. episodeRatingKey is NOT FK'd (no episodes
// table exists to reference); seasonRatingKey and showRatingKey are FK'd since those
// parent rows do exist. episodeTitle/episodeIndex/seasonIndex are denormalized here
// since there's nowhere else per-episode metadata is ever stored for TV libraries.
export const episodeMediaVersions = sqliteTable(
  'episode_media_versions',
  {
    serverId: integer('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    mediaId: integer('media_id').notNull(),
    episodeRatingKey: text('episode_rating_key').notNull(),
    seasonRatingKey: text('season_rating_key').notNull(),
    showRatingKey: text('show_rating_key').notNull(),
    libraryKey: text('library_key').notNull(),
    episodeTitle: text('episode_title').notNull(),
    episodeIndex: integer('episode_index').notNull(),
    seasonIndex: integer('season_index').notNull(),
    videoResolution: text('video_resolution'),
    bitrate: integer('bitrate'),
    videoCodec: text('video_codec'),
    container: text('container'),
    fileSize: integer('file_size'), // decimal KB, same convention as itemMediaVersions
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.serverId, table.mediaId] }),
    seasonFk: foreignKey({
      columns: [table.serverId, table.seasonRatingKey],
      foreignColumns: [seasons.serverId, seasons.ratingKey],
    }).onDelete('cascade'),
    showFk: foreignKey({
      columns: [table.serverId, table.showRatingKey],
      foreignColumns: [items.serverId, items.ratingKey],
    }).onDelete('cascade'),
    libraryFk: foreignKey({
      columns: [table.serverId, table.libraryKey],
      foreignColumns: [libraries.serverId, libraries.key],
    }).onDelete('cascade'),
    episodeIdx: index('episode_media_versions_episode_idx').on(
      table.serverId,
      table.episodeRatingKey,
    ),
    libraryIdx: index('episode_media_versions_library_idx').on(table.serverId, table.libraryKey),
    showIdx: index('episode_media_versions_show_idx').on(table.serverId, table.showRatingKey),
  }),
);

export const syncLog = sqliteTable(
  'sync_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: integer('server_id').references(() => servers.id),
    libraryKey: text('library_key'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    status: text('status', { enum: ['pending', 'success', 'error'] }).notNull(),
    itemsProcessed: integer('items_processed').default(0),
    error: text('error'),
  },
  (table) => ({
    // Backs pruneOldSyncLogs' `WHERE finished_at < cutoff` — without this, that query
    // (run hourly, and at startup) is a full table scan for the life of the container.
    finishedAtIdx: index('sync_log_finished_at_idx').on(table.finishedAt),
  }),
);

// General admin activity log — one row per meaningful action (a completed sync, a
// batch deletion, etc.), not per underlying DB write. Deliberately separate from
// sync_log: sync_log has typed columns and in-flight progress plumbing for the
// sync-only view, while this table is a generic, append-only feed for everything
// else. A sync still gets a row here too (referencing its sync_log id via payload)
// so it shows up in the unified feed without this table needing to know sync_log's
// schema. No `summary` column: the human-readable line is rendered from `type` +
// `payload` at display time (frontend), not persisted, so wording can still be
// changed/localized for events that already happened.
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: integer('server_id').references(() => servers.id),
    type: text('type', {
      enum: ['sync.completed', 'sync.failed', 'items.deleted', 'media.deleted', 'user.removed'],
    })
      .notNull(),
    payload: text('payload'), // JSON: event-specific detail, see EventType in shared/types.ts
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    // Matches the activity feed's actual query shape (WHERE server_id = ? ORDER BY id DESC).
    serverIdIdx: index('events_server_id_idx').on(table.serverId, table.id),
    // Backs pruneOldEvents' `WHERE created_at < cutoff`, filtered independently of id/serverId.
    createdAtIdx: index('events_created_at_idx').on(table.createdAt),
  }),
);
