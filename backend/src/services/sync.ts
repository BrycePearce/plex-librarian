import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { items, libraries, syncLog } from '../db/schema.ts';
import { createPlexClient } from '../lib/plex.ts';

// Derives the SQL excluded.column_name string from the schema column object so that
// a rename in schema.ts + migration automatically updates the upsert set clause.
const excl = (c: { name: string }) => sql.raw(`excluded.${c.name}`);

export async function runSync(syncId: number): Promise<void> {
  try {
    const plex = createPlexClient();
    const plexLibraries = await plex.libraries();
    const now = Math.floor(Date.now() / 1000);
    let totalItems = 0;

    for (const lib of plexLibraries) {
      await db
        .insert(libraries)
        .values({ key: lib.key, title: lib.title, type: lib.type, syncedAt: now })
        .onConflictDoUpdate({
          target: libraries.key,
          set: { title: lib.title, type: lib.type, syncedAt: now },
        });

      let hasItems = false;
      for await (const page of plex.libraryItems(lib.key)) {
        if (page.length === 0) continue;
        hasItems = true;
        await db
          .insert(items)
          .values(
            page.map((item) => ({
              ratingKey: item.ratingKey,
              libraryKey: lib.key,
              title: item.title,
              type: item.type,
              addedAt: item.addedAt,
              lastViewedAt: item.lastViewedAt,
              viewCount: item.viewCount,
              fileSize: item.fileSize,
              duration: item.duration,
              year: item.year,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: items.ratingKey,
            set: {
              libraryKey: excl(items.libraryKey),
              title: excl(items.title),
              type: excl(items.type),
              addedAt: excl(items.addedAt),
              lastViewedAt: excl(items.lastViewedAt),
              viewCount: excl(items.viewCount),
              fileSize: excl(items.fileSize),
              duration: excl(items.duration),
              year: excl(items.year),
              updatedAt: excl(items.updatedAt),
            },
          });
        totalItems += page.length;
      }

      // Skip pruning when Plex returned zero items — could be a transient 200 with
      // no Metadata key rather than a genuinely empty library, and a false empty
      // would wipe all rows for the library.
      if (hasItems) {
        await db.delete(items).where(and(eq(items.libraryKey, lib.key), lt(items.updatedAt, now)));
      }
    }

    await db
      .update(syncLog)
      .set({
        status: 'success',
        finishedAt: Math.floor(Date.now() / 1000),
        itemsProcessed: totalItems,
      })
      .where(eq(syncLog.id, syncId));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db
      .update(syncLog)
      .set({ status: 'error', finishedAt: Math.floor(Date.now() / 1000), error })
      .where(eq(syncLog.id, syncId));
  }
}
