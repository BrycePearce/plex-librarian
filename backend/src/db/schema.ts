import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const libraries = sqliteTable('libraries', {
  key: text('key').primaryKey(),
  title: text('title').notNull(),
  type: text('type').notNull(),
  syncedAt: integer('synced_at').notNull(),
});

export const items = sqliteTable(
  'items',
  {
    ratingKey: text('rating_key').primaryKey(),
    libraryKey: text('library_key').notNull().references(() => libraries.key, {
      onDelete: 'cascade',
    }),
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
    lastViewedAtIdx: index('items_last_viewed_at_idx').on(table.lastViewedAt),
    libraryStaleIdx: index('items_library_stale_idx').on(table.libraryKey, table.lastViewedAt),
    libraryFileSizeIdx: index('items_library_file_size_idx').on(table.libraryKey, table.fileSize),
  }),
);

// Singleton row (id = 1) — stores installation identity and Plex credentials.
// Env vars PLEX_URL + PLEX_TOKEN take precedence over this table at runtime.
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  clientId: text('client_id').notNull(),
  publicJwk: text('public_jwk'),
  privateJwk: text('private_jwk'),
  plexToken: text('plex_token'),
  plexTokenExpiresAt: integer('plex_token_expires_at'), // reserved for future JWT expiry — PIN tokens don't expire
  plexUrl: text('plex_url'),
  autoSyncEnabled: integer('auto_sync_enabled', { mode: 'boolean' }).default(true),
  autoSyncHour: integer('auto_sync_hour').default(3), // 0–23 local server time; default 3am
});

export const seasons = sqliteTable(
  'seasons',
  {
    ratingKey: text('rating_key').primaryKey(),
    showRatingKey: text('show_rating_key').notNull().references(() => items.ratingKey, {
      onDelete: 'cascade',
    }),
    libraryKey: text('library_key').notNull().references(() => libraries.key, {
      onDelete: 'cascade',
    }),
    seasonIndex: integer('season_index').notNull(),
    title: text('title').notNull(),
    fileSize: integer('file_size'),
    duration: integer('duration'),
    leafCount: integer('leaf_count'),
    viewCount: integer('view_count').default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    showIdx: index('seasons_show_idx').on(table.showRatingKey),
    libraryIdx: index('seasons_library_idx').on(table.libraryKey),
  }),
);

export const syncLog = sqliteTable('sync_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  libraryKey: text('library_key'),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  status: text('status', { enum: ['pending', 'success', 'error'] }).notNull(),
  itemsProcessed: integer('items_processed').default(0),
  error: text('error'),
});
