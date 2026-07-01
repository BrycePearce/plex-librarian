import { and, eq, lt, sql } from 'drizzle-orm';
import { db, withTransaction } from '../db/index.ts';
import { items, libraries, seasons, syncLog } from '../db/schema.ts';
import { createPlexClient, PLEX_TYPE } from '../lib/plex.ts';
import type { PlexClient, PlexLibrary } from '../lib/plex.ts';
import type { LibraryPhase } from '@plex-librarian/shared/types.ts';

// Derives the SQL excluded.column_name string from the schema column object so that
// a rename in schema.ts + migration automatically updates the upsert set clause.
const excl = (c: { name: string }) => sql.raw(`excluded.${c.name}`);

// Max libraries synced concurrently. Each library already uses FETCH_CONCURRENCY=8
// parallel Plex requests internally, so this keeps total concurrent requests bounded.
const LIBRARY_SYNC_CONCURRENCY = 3;

export type SyncReporter = {
  onLibraries?: (libs: { key: string; title: string }[]) => void;
  onPhase?: (libraryKey: string, phase: LibraryPhase) => void;
  onCount?: (libraryKey: string, delta: number) => void;
};

type LibraryCallbacks = {
  onCount: (delta: number) => void;
  onPhase: (phase: LibraryPhase) => void;
};

function buildCallbacks(
  reporter: SyncReporter | undefined,
  libraryKey: string,
  accumulate: (delta: number) => void,
): LibraryCallbacks {
  return {
    onCount: (delta) => {
      accumulate(delta);
      reporter?.onCount?.(libraryKey, delta);
    },
    onPhase: (phase) => reporter?.onPhase?.(libraryKey, phase),
  };
}

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

// Fetches all tracks for a music library and rolls their file sizes up to the artist row.
// Mirrors syncShowSizes: artists have no Media[] in Plex's artist-level response, so sizes
// must be aggregated from the leaf type (tracks, type=10) instead.
async function syncArtistSizes(
  plex: PlexClient,
  lib: PlexLibrary,
): Promise<void> {
  const artistTotals = new Map<string, number>();

  for await (const page of plex.libraryTracks(lib.key)) {
    for (const track of page) {
      if (track.fileSize == null) continue;
      artistTotals.set(
        track.artistRatingKey,
        (artistTotals.get(track.artistRatingKey) ?? 0) + track.fileSize,
      );
    }
  }

  if (artistTotals.size === 0) return;

  withTransaction((client) => {
    const stmt = client.prepare(
      `UPDATE items SET file_size = ? WHERE rating_key = ? AND library_key = ? AND type = 'artist'`,
    );
    for (const [ratingKey, fileSize] of artistTotals) {
      stmt.run(fileSize, ratingKey, lib.key);
    }
  });
}

// Walks /status/sessions/history/all?librarySectionID=<key> to get cross-user play history
// for the entire library in one paginated stream instead of one request per item.
// For episodes the play is attributed to the show (grandparentRatingKey); for movies the
// movie ratingKey is used directly. Artist libraries have no useful play history here.
async function syncLibraryHistory(plex: PlexClient, lib: PlexLibrary): Promise<void> {
  if (lib.type === 'artist') return;

  // Build ratingKey → max(viewedAt) across all users and all pages before writing.
  // The map is bounded by unique items in the library (not total play count).
  const maxViewedAt = new Map<string, number>();

  for await (const page of plex.libraryHistory(lib.key)) {
    for (const entry of page) {
      if (!entry.viewedAt) continue;
      // Episodes carry grandparentKey ("/library/metadata/76749") — extract trailing numeric ID.
      // If grandparentKey exists but has no numeric match (malformed path), skip rather than
      // falling back to the episode ratingKey, which is never stored in items for TV libraries.
      const key = entry.grandparentKey
        ? entry.grandparentKey.match(/(\d+)\/?$/)?.[1]
        : entry.ratingKey;
      if (!key) continue;
      const cur = maxViewedAt.get(key);
      if (!cur || entry.viewedAt > cur) maxViewedAt.set(key, entry.viewedAt);
    }
  }

  if (maxViewedAt.size === 0) return;

  // All UPDATEs in a single transaction — one commit instead of N individual fsyncs.
  withTransaction((client) => {
    const stmt = client.prepare(
      `UPDATE items SET last_viewed_at = ?
       WHERE rating_key = ? AND library_key = ?
         AND (last_viewed_at IS NULL OR last_viewed_at < ?)`,
    );
    for (const [ratingKey, viewedAt] of maxViewedAt) {
      stmt.run(viewedAt, ratingKey, lib.key, viewedAt);
    }
  });
}

async function syncLibrary(
  plex: PlexClient,
  lib: PlexLibrary,
  now: number,
  callbacks?: LibraryCallbacks,
): Promise<number> {
  callbacks?.onPhase('items');

  await db
    .insert(libraries)
    .values({ key: lib.key, title: lib.title, type: lib.type, syncedAt: now })
    .onConflictDoUpdate({
      target: libraries.key,
      set: { title: lib.title, type: lib.type, syncedAt: now },
    });

  const typeFilter = lib.type === 'show'
    ? PLEX_TYPE.SHOW
    : lib.type === 'artist'
    ? PLEX_TYPE.ARTIST
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
    callbacks?.onCount(page.length);
  }

  // Both size-rollup functions run before the prune, for different reasons.
  // syncShowSizes: the seasons table has FK(show_rating_key) → items.rating_key
  // ON DELETE CASCADE. If shows were pruned first and Plex's episode endpoint
  // still returns episodes for a recently-deleted show (cache lag), the subsequent
  // season INSERT would hit a FK constraint violation. Running before the prune
  // means orphaned season rows are cascade-deleted by the prune step instead.
  // syncArtistSizes: runs before the prune so its UPDATEs land on live item rows;
  // after the prune, deleted artists are gone and the UPDATEs would silently no-op.
  if (lib.type === 'show') {
    callbacks?.onPhase('episodes');
    await syncShowSizes(plex, lib, now);
  } else if (lib.type === 'artist') {
    callbacks?.onPhase('tracks');
    await syncArtistSizes(plex, lib);
  }

  if (itemCount > 0) {
    await db.delete(items).where(and(eq(items.libraryKey, lib.key), lt(items.updatedAt, now)));
  }

  callbacks?.onPhase('history');
  await syncLibraryHistory(plex, lib);

  callbacks?.onPhase('done');

  return itemCount;
}

export async function finalizeSyncLog(
  syncId: number,
  result: { ok: true; itemsProcessed: number } | { ok: false; error: string },
): Promise<void> {
  const finishedAt = Math.floor(Date.now() / 1000);
  // AND status='pending' guard prevents a late onerror or retry from overwriting an already-finalized row.
  const where = and(eq(syncLog.id, syncId), eq(syncLog.status, 'pending'));
  if (!result.ok) {
    await db.update(syncLog).set({ status: 'error', finishedAt, error: result.error }).where(where);
  } else {
    await db.update(syncLog).set({
      status: 'success',
      finishedAt,
      itemsProcessed: result.itemsProcessed,
    }).where(where);
  }
}

// Pure sync logic — throws on error, returns total items processed.
// The caller (Worker) is responsible for try/catch and finalizeSyncLog.
export async function runSync(reporter?: SyncReporter): Promise<number> {
  const plex = await createPlexClient();
  const plexLibraries = await plex.libraries();
  const now = Math.floor(Date.now() / 1000);

  reporter?.onLibraries?.(plexLibraries.map((l) => ({ key: l.key, title: l.title })));

  let totalItems = 0;

  for (let i = 0; i < plexLibraries.length; i += LIBRARY_SYNC_CONCURRENCY) {
    const batch = plexLibraries.slice(i, i + LIBRARY_SYNC_CONCURRENCY);
    await Promise.all(
      batch.map((lib) =>
        syncLibrary(
          plex,
          lib,
          now,
          buildCallbacks(reporter, lib.key, (d) => {
            totalItems += d;
          }),
        )
      ),
    );
  }

  return totalItems;
}

// Pure sync logic for a single library — throws on error, returns items processed.
// The caller (Worker) is responsible for try/catch and finalizeSyncLog.
export async function runLibrarySync(libraryKey: string, reporter?: SyncReporter): Promise<number> {
  const plex = await createPlexClient();
  const [lib] = await db
    .select({ key: libraries.key, title: libraries.title, type: libraries.type })
    .from(libraries)
    .where(eq(libraries.key, libraryKey))
    .limit(1);
  if (!lib) throw new Error(`Library ${libraryKey} not found`);

  reporter?.onLibraries?.([{ key: lib.key, title: lib.title }]);

  const now = Math.floor(Date.now() / 1000);
  let itemCount = 0;
  await syncLibrary(
    plex,
    lib,
    now,
    buildCallbacks(reporter, libraryKey, (d) => {
      itemCount += d;
    }),
  );
  return itemCount;
}
