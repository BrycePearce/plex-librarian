import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { items, libraries, seasons, syncLog } from '../db/schema.ts';
import { createPlexClient, PLEX_TYPE } from '../lib/plex.ts';
import type { PlexClient } from '../lib/plex.ts';
import type { PlexLibrary } from '../types/plex.ts';

// Derives the SQL excluded.column_name string from the schema column object so that
// a rename in schema.ts + migration automatically updates the upsert set clause.
const excl = (c: { name: string }) => sql.raw(`excluded.${c.name}`);

// Max libraries synced concurrently. Each library already uses FETCH_CONCURRENCY=8
// parallel Plex requests internally, so this keeps total concurrent requests bounded.
const LIBRARY_SYNC_CONCURRENCY = 3;

// Max rows per seasons INSERT to avoid oversized statements on large TV libraries.
const SEASON_UPSERT_BATCH = 500;

// Streams all episodes for a TV library, aggregates file sizes by season in a
// bounded map (entries ≈ shows × avg-seasons, not episode count), then upserts
// into the seasons table and rolls totals up to the show-level items row.
async function syncShowSizes(
  plex: PlexClient,
  lib: PlexLibrary,
  now: number,
): Promise<void> {
  type SeasonAgg = {
    showRatingKey: string;
    seasonIndex: number;
    title: string;
    fileSize: number;
    duration: number;
    leafCount: number;
    viewCount: number;
  };
  // The map accumulates across all episode pages before any upsert. This is intentional:
  // a season's episodes are not guaranteed to arrive contiguously across pages, so we
  // can't upsert a season's totals until the entire episode stream is exhausted. The map
  // is bounded by shows × avg-seasons (not episode count) — for a 10k-show library with
  // ~5 seasons each that's ~50k entries, well within acceptable memory.
  const seasonMap = new Map<string, SeasonAgg>();

  for await (const page of plex.libraryEpisodes(lib.key)) {
    for (const ep of page) {
      const agg = seasonMap.get(ep.seasonRatingKey);
      if (agg) {
        agg.fileSize += ep.fileSize ?? 0;
        agg.duration += ep.duration ?? 0;
        agg.leafCount += 1;
        agg.viewCount += ep.viewCount;
      } else {
        seasonMap.set(ep.seasonRatingKey, {
          showRatingKey: ep.showRatingKey,
          seasonIndex: ep.seasonIndex,
          title: ep.seasonTitle,
          fileSize: ep.fileSize ?? 0,
          duration: ep.duration ?? 0,
          leafCount: 1,
          viewCount: ep.viewCount,
        });
      }
    }
  }

  // No episodes fetched — transient empty response or all filtered. Skip prune and
  // rollup to preserve existing season data rather than wiping it. Mirrors the
  // hasItems guard on the items prune in syncLibrary.
  if (seasonMap.size === 0) return;

  const entries = [...seasonMap.entries()];
  for (let i = 0; i < entries.length; i += SEASON_UPSERT_BATCH) {
    const batch = entries.slice(i, i + SEASON_UPSERT_BATCH);
    await db
      .insert(seasons)
      .values(
        batch.map(([ratingKey, agg]) => ({
          ratingKey,
          showRatingKey: agg.showRatingKey,
          libraryKey: lib.key,
          seasonIndex: agg.seasonIndex,
          title: agg.title,
          fileSize: agg.fileSize > 0 ? agg.fileSize : null,
          duration: agg.duration > 0 ? agg.duration : null,
          leafCount: agg.leafCount,
          viewCount: agg.viewCount,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: seasons.ratingKey,
        set: {
          showRatingKey: excl(seasons.showRatingKey),
          libraryKey: excl(seasons.libraryKey),
          seasonIndex: excl(seasons.seasonIndex),
          title: excl(seasons.title),
          fileSize: excl(seasons.fileSize),
          duration: excl(seasons.duration),
          leafCount: excl(seasons.leafCount),
          viewCount: excl(seasons.viewCount),
          updatedAt: excl(seasons.updatedAt),
        },
      });
  }

  // Prune season rows for shows deleted from this library since the last sync.
  await db
    .delete(seasons)
    .where(and(eq(seasons.libraryKey, lib.key), lt(seasons.updatedAt, now)));

  // Roll season sizes up to the show row so the stale list can display total size.
  // COALESCE preserves the existing value when SUM returns NULL (all season sizes unknown).
  // The library_key filter on the subquery prevents cross-library inflation when the same
  // show ratingKey appears in more than one library.
  await db.run(sql`
    UPDATE items
    SET file_size = COALESCE(
      (SELECT SUM(file_size) FROM seasons WHERE show_rating_key = items.rating_key AND library_key = ${lib.key}),
      file_size
    )
    WHERE library_key = ${lib.key} AND type = 'show'
  `);
}

async function syncLibrary(
  plex: PlexClient,
  lib: PlexLibrary,
  now: number,
): Promise<number> {
  await db
    .insert(libraries)
    .values({ key: lib.key, title: lib.title, type: lib.type, syncedAt: now })
    .onConflictDoUpdate({
      target: libraries.key,
      set: { title: lib.title, type: lib.type, syncedAt: now },
    });

  const typeFilter = lib.type === 'show' ? PLEX_TYPE.SHOW
    : lib.type === 'artist' ? PLEX_TYPE.ARTIST
    : undefined;

  let itemCount = 0;

  for await (const page of plex.libraryItems(lib.key, typeFilter)) {
    if (page.length === 0) continue;
    await db
      .insert(items)
      .values(
        page.map((item) => ({
          ratingKey: item.ratingKey,
          libraryKey: lib.key,
          title: item.title,
          type: item.type,
          thumb: item.thumb,
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
          thumb: excl(items.thumb),
          addedAt: excl(items.addedAt),
          lastViewedAt: excl(items.lastViewedAt),
          viewCount: excl(items.viewCount),
          fileSize: excl(items.fileSize),
          duration: excl(items.duration),
          year: excl(items.year),
          updatedAt: excl(items.updatedAt),
        },
      });
    itemCount += page.length;
  }

  if (itemCount > 0) {
    await db.delete(items).where(and(eq(items.libraryKey, lib.key), lt(items.updatedAt, now)));
  }

  if (lib.type === 'show') {
    await syncShowSizes(plex, lib, now);
  }

  return itemCount;
}

async function finalizeSyncLog(
  syncId: number,
  result: { ok: true; itemsProcessed: number } | { ok: false; error: string },
): Promise<void> {
  const finishedAt = Math.floor(Date.now() / 1000);
  if (!result.ok) {
    await db.update(syncLog).set({ status: 'error', finishedAt, error: result.error }).where(eq(syncLog.id, syncId));
  } else {
    await db.update(syncLog).set({ status: 'success', finishedAt, itemsProcessed: result.itemsProcessed }).where(eq(syncLog.id, syncId));
  }
}

export async function runSync(syncId: number): Promise<void> {
  try {
    const plex = await createPlexClient();
    const plexLibraries = await plex.libraries();
    const now = Math.floor(Date.now() / 1000);
    let totalItems = 0;

    for (let i = 0; i < plexLibraries.length; i += LIBRARY_SYNC_CONCURRENCY) {
      const batch = plexLibraries.slice(i, i + LIBRARY_SYNC_CONCURRENCY);
      const counts = await Promise.all(batch.map((lib) => syncLibrary(plex, lib, now)));
      totalItems += counts.reduce((a, b) => a + b, 0);
    }

    await finalizeSyncLog(syncId, { ok: true, itemsProcessed: totalItems });
  } catch (err) {
    await finalizeSyncLog(syncId, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function runLibrarySync(libraryKey: string, syncId: number): Promise<void> {
  try {
    const plex = await createPlexClient();
    const [lib] = await db
      .select({ key: libraries.key, title: libraries.title, type: libraries.type })
      .from(libraries)
      .where(eq(libraries.key, libraryKey))
      .limit(1);
    if (!lib) throw new Error(`Library ${libraryKey} not found`);

    const now = Math.floor(Date.now() / 1000);
    const itemCount = await syncLibrary(plex, lib, now);
    await finalizeSyncLog(syncId, { ok: true, itemsProcessed: itemCount });
  } catch (err) {
    await finalizeSyncLog(syncId, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
