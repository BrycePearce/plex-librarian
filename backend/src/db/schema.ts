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
});

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
      enum: ['sync.completed', 'sync.failed', 'items.deleted', 'media.deleted'],
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
