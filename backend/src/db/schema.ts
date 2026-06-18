import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  }),
);

export const syncLog = sqliteTable(
  'sync_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    status: text('status', { enum: ['pending', 'success', 'error'] }).notNull(),
    itemsProcessed: integer('items_processed').default(0),
    error: text('error'),
  },
  (table) => ({
    onePendingSync: uniqueIndex('sync_log_one_pending_idx')
      .on(table.status)
      .where(sql`${table.status} = 'pending'`),
  }),
);
