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
    type: text('type', { enum: ['sync.completed', 'sync.failed', 'items.deleted'] }).notNull(),
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
