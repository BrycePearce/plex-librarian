import { and, eq, lt, notInArray, type SQL, sql } from 'drizzle-orm';
import { db, withTransaction } from '../db/index.ts';
import {
  episodeMediaVersions,
  itemMediaVersions,
  items,
  libraries,
  seasons,
  syncLog,
} from '../db/schema.ts';
import {
  episodeVersionsByLibrary,
  itemsByLibrary,
  libraryByKey,
  mediaVersionsByLibrary,
  seasonsByLibrary,
} from '../db/scope.ts';
import { PLEX_TYPE } from '../lib/plex.ts';
import type { PlexClient, PlexEpisodeMediaVersion, PlexLibrary } from '../lib/plex.ts';
import { logEvents } from './events.ts';
import type { LogEventInput } from './events.ts';
import type { LibraryPhase } from '@plex-librarian/shared/types.ts';

// Derives the SQL excluded.column_name string from the schema column object so that
// a rename in schema.ts + migration automatically updates the upsert set clause.
const excl = (c: { name: string }) => sql.raw(`excluded.${c.name}`);

// Max libraries synced concurrently. Each library already uses FETCH_CONCURRENCY
// parallel Plex requests internally, so this keeps total concurrent requests bounded.
// Override via LIBRARY_SYNC_CONCURRENCY env var.
const LIBRARY_SYNC_CONCURRENCY = Math.max(
  1,
  parseInt(Deno.env.get('LIBRARY_SYNC_CONCURRENCY') ?? '', 10) || 3,
);

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
  serverId: number,
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
  // Already filtered to genuine duplicates (2+ valid Media entries) by
  // mapEpisodeMediaVersions — stays small (bounded by duplicate-episode count, not
  // total episode count) so accumulating the whole thing in memory is cheap, unlike
  // episode counts themselves. Can't upsert per-page like itemMediaVersions does for
  // movies: episodeMediaVersions.seasonRatingKey FKs to `seasons`, whose rows don't
  // exist until the season upsert below runs, which itself can't happen until the
  // entire episode stream is drained (see seasonMap's own comment above).
  const episodeVersions: PlexEpisodeMediaVersion[] = [];

  for await (const page of plex.libraryEpisodes(lib.key)) {
    for (const ep of page.episodes) {
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
    episodeVersions.push(...page.episodeMediaVersions);
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
          serverId,
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
        target: [seasons.serverId, seasons.ratingKey],
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

  // Only reached once the parent season rows above are guaranteed to exist (this
  // sync's episode stream is fully drained and every season upserted), satisfying
  // episodeMediaVersions.seasonRatingKey's FK — see episodeVersions' own comment above.
  for (let i = 0; i < episodeVersions.length; i += SEASON_UPSERT_BATCH) {
    const batch = episodeVersions.slice(i, i + SEASON_UPSERT_BATCH);
    await db
      .insert(episodeMediaVersions)
      .values(
        batch.map((v) => ({
          serverId,
          mediaId: v.mediaId,
          episodeRatingKey: v.episodeRatingKey,
          seasonRatingKey: v.seasonRatingKey,
          showRatingKey: v.showRatingKey,
          libraryKey: lib.key,
          episodeTitle: v.episodeTitle,
          episodeIndex: v.episodeIndex,
          seasonIndex: v.seasonIndex,
          videoResolution: v.videoResolution,
          bitrate: v.bitrate,
          videoCodec: v.videoCodec,
          container: v.container,
          fileSize: v.fileSize,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [episodeMediaVersions.serverId, episodeMediaVersions.mediaId],
        set: {
          episodeRatingKey: excl(episodeMediaVersions.episodeRatingKey),
          seasonRatingKey: excl(episodeMediaVersions.seasonRatingKey),
          showRatingKey: excl(episodeMediaVersions.showRatingKey),
          libraryKey: excl(episodeMediaVersions.libraryKey),
          episodeTitle: excl(episodeMediaVersions.episodeTitle),
          episodeIndex: excl(episodeMediaVersions.episodeIndex),
          seasonIndex: excl(episodeMediaVersions.seasonIndex),
          videoResolution: excl(episodeMediaVersions.videoResolution),
          bitrate: excl(episodeMediaVersions.bitrate),
          videoCodec: excl(episodeMediaVersions.videoCodec),
          container: excl(episodeMediaVersions.container),
          fileSize: excl(episodeMediaVersions.fileSize),
          updatedAt: excl(episodeMediaVersions.updatedAt),
        },
      });
  }

  // Prune season rows for shows deleted from this library since the last sync.
  await db
    .delete(seasons)
    .where(and(seasonsByLibrary(serverId, lib.key), lt(seasons.updatedAt, now)));

  // Runs after the seasons prune (not before) purely to avoid redundant work: any
  // episode-version row belonging to a show/season pruned above is already
  // cascade-deleted by that prune (both showRatingKey->items and
  // seasonRatingKey->seasons cascade). This explicit prune only catches the remaining
  // case — the show/season still exists, but a specific episode version disappeared
  // from Plex between syncs.
  await db.delete(episodeMediaVersions).where(
    and(episodeVersionsByLibrary(serverId, lib.key), lt(episodeMediaVersions.updatedAt, now)),
  );

  // Roll season sizes up to the show row so the stale list can display total size.
  // COALESCE preserves the existing value when SUM returns NULL (all season sizes unknown).
  // The server_id + library_key filter on the subquery prevents cross-library/cross-server
  // inflation when the same show ratingKey appears elsewhere.
  await db.run(sql`
    UPDATE items
    SET file_size = COALESCE(
      (SELECT SUM(file_size) FROM seasons WHERE server_id = ${serverId} AND show_rating_key = items.rating_key AND library_key = ${lib.key}),
      file_size
    )
    WHERE server_id = ${serverId} AND library_key = ${lib.key} AND type = 'show'
  `);
}

// Fetches all tracks for a music library and rolls their file sizes up to the artist row.
// Mirrors syncShowSizes: artists have no Media[] in Plex's artist-level response, so sizes
// must be aggregated from the leaf type (tracks, type=10) instead.
async function syncArtistSizes(
  plex: PlexClient,
  lib: PlexLibrary,
  serverId: number,
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
      `UPDATE items SET file_size = ? WHERE server_id = ? AND rating_key = ? AND library_key = ? AND type = 'artist'`,
    );
    for (const [ratingKey, fileSize] of artistTotals) {
      stmt.run(fileSize, serverId, ratingKey, lib.key);
    }
  });
}

// Walks /status/sessions/history/all?librarySectionID=<key> to get cross-user play history
// for the entire library in one paginated stream instead of one request per item.
// For episodes the play is attributed to the show (grandparentRatingKey); for movies the
// movie ratingKey is used directly. Artist libraries have no useful play history here.
async function syncLibraryHistory(
  plex: PlexClient,
  lib: PlexLibrary,
  serverId: number,
): Promise<void> {
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
       WHERE server_id = ? AND rating_key = ? AND library_key = ?
         AND (last_viewed_at IS NULL OR last_viewed_at < ?)`,
    );
    for (const [ratingKey, viewedAt] of maxViewedAt) {
      stmt.run(viewedAt, serverId, ratingKey, lib.key, viewedAt);
    }
  });
}

async function syncLibrary(
  plex: PlexClient,
  lib: PlexLibrary,
  now: number,
  serverId: number,
  callbacks?: LibraryCallbacks,
): Promise<number> {
  callbacks?.onPhase('items');

  // historySyncedAt is reset to null here — it's only set back once syncLibraryHistory
  // completes below, so a run that crashes anywhere in between leaves it null rather
  // than carrying over a stale "confirmed" timestamp from a previous, unrelated run.
  await db
    .insert(libraries)
    .values({
      serverId,
      key: lib.key,
      title: lib.title,
      type: lib.type,
      syncedAt: now,
      historySyncedAt: null,
    })
    .onConflictDoUpdate({
      target: [libraries.serverId, libraries.key],
      set: { title: lib.title, type: lib.type, syncedAt: now, historySyncedAt: null },
    });

  const typeFilter = lib.type === 'show'
    ? PLEX_TYPE.SHOW
    : lib.type === 'artist'
    ? PLEX_TYPE.ARTIST
    : undefined;

  let itemCount = 0;

  for await (const page of plex.libraryItems(lib.key, typeFilter)) {
    if (page.items.length === 0) continue;
    await db
      .insert(items)
      .values(
        page.items.map((item) => ({
          serverId,
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
        target: [items.serverId, items.ratingKey],
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
    itemCount += page.items.length;
    callbacks?.onCount(page.items.length);

    // Items must be upserted before their media versions within this same page — the
    // FK(server_id, item_rating_key) → items(server_id, rating_key) needs the parent
    // row to already exist. Only ever non-empty for movie libraries (see libraryItems).
    if (page.mediaVersions.length > 0) {
      await db
        .insert(itemMediaVersions)
        .values(
          page.mediaVersions.map((v) => ({
            serverId,
            mediaId: v.mediaId,
            itemRatingKey: v.itemRatingKey,
            libraryKey: lib.key,
            videoResolution: v.videoResolution,
            bitrate: v.bitrate,
            videoCodec: v.videoCodec,
            container: v.container,
            fileSize: v.fileSize,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [itemMediaVersions.serverId, itemMediaVersions.mediaId],
          set: {
            itemRatingKey: excl(itemMediaVersions.itemRatingKey),
            libraryKey: excl(itemMediaVersions.libraryKey),
            videoResolution: excl(itemMediaVersions.videoResolution),
            bitrate: excl(itemMediaVersions.bitrate),
            videoCodec: excl(itemMediaVersions.videoCodec),
            container: excl(itemMediaVersions.container),
            fileSize: excl(itemMediaVersions.fileSize),
            updatedAt: excl(itemMediaVersions.updatedAt),
          },
        });
    }
  }

  // Both size-rollup functions run before the prune, for different reasons.
  // syncShowSizes: the seasons table has FK(server_id, show_rating_key) → items(server_id,
  // rating_key) ON DELETE CASCADE. If shows were pruned first and Plex's episode endpoint
  // still returns episodes for a recently-deleted show (cache lag), the subsequent
  // season INSERT would hit a FK constraint violation. Running before the prune
  // means orphaned season rows are cascade-deleted by the prune step instead.
  // syncArtistSizes: runs before the prune so its UPDATEs land on live item rows;
  // after the prune, deleted artists are gone and the UPDATEs would silently no-op.
  if (lib.type === 'show') {
    callbacks?.onPhase('episodes');
    await syncShowSizes(plex, lib, now, serverId);
  } else if (lib.type === 'artist') {
    callbacks?.onPhase('tracks');
    await syncArtistSizes(plex, lib, serverId);
  }

  if (itemCount > 0) {
    await db.delete(items).where(and(itemsByLibrary(serverId, lib.key), lt(items.updatedAt, now)));
    // Cascade-deletes media-version rows for any item pruned above. This explicit prune
    // additionally catches the case where the parent item still exists but one specific
    // version disappeared from Plex between syncs (e.g. deleted directly in Plex).
    await db.delete(itemMediaVersions).where(
      and(mediaVersionsByLibrary(serverId, lib.key), lt(itemMediaVersions.updatedAt, now)),
    );
  }

  callbacks?.onPhase('history');
  await syncLibraryHistory(plex, lib, serverId);
  // Only reached if syncLibraryHistory didn't throw — marks this library's lastViewedAt
  // data as trustworthy for the current sync attempt (see historySyncedAt in schema.ts).
  await db.update(libraries).set({ historySyncedAt: now }).where(libraryByKey(serverId, lib.key));

  callbacks?.onPhase('done');

  return itemCount;
}

// Finalizes the sync_log row and, if this call actually won the race to do so, logs the
// matching activity event itself — mirroring failPendingSyncsMatching below, which emits
// events from the rows it actually updated rather than trusting a caller to remember a
// guard. If something else (e.g. the stale-pending sweep) already finalized this row
// first, `.returning()` comes back empty and no contradictory event is logged.
export async function finalizeSyncLog(
  syncId: number,
  serverId: number,
  libraryKey: string | null,
  result: { ok: true; itemsProcessed: number } | { ok: false; error: string },
): Promise<void> {
  const finishedAt = Math.floor(Date.now() / 1000);
  const setPayload = result.ok
    ? { status: 'success' as const, finishedAt, itemsProcessed: result.itemsProcessed }
    : { status: 'error' as const, finishedAt, error: result.error };
  // AND status='pending' guard prevents a late onerror or retry from overwriting an already-finalized row.
  const where = and(eq(syncLog.id, syncId), eq(syncLog.status, 'pending'));
  const rows = await db.update(syncLog).set(setPayload).where(where).returning({ id: syncLog.id });

  if (rows.length === 0) return;

  await logEvents([
    result.ok
      ? {
        serverId,
        type: 'sync.completed',
        payload: { syncId, libraryKey, itemsProcessed: result.itemsProcessed },
      }
      : {
        serverId,
        type: 'sync.failed',
        payload: { syncId, libraryKey, error: result.error },
      },
  ]);
}

// Formats a duration for the crash-recovery reason text below — kept in sync with the
// actual cutoff passed in, rather than a hardcoded string, so the message can't drift
// from reality if a caller ever passes something other than the current 1-hour default.
function formatRoughDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Shared by the two crash-recovery sweeps (main.ts's unconditional startup sweep and
// scheduler.ts's hourly stale-pending sweep) — marks matching pending rows as 'error'
// and emits a sync.failed activity event for each, so a process crash or a hung sync
// shows up in the activity log the same way a normal in-process sync failure does.
// Without this, the only place a crash was ever recorded was the sync_log row itself.
// `reason` is caller-supplied since the two callers cover genuinely different situations
// (an actual crash+restart vs. a sync that merely stopped making progress without the
// process dying); it's folded into the persisted `error` text, and the frontend renders
// the rest of the sentence (which library, if any) from `payload.libraryKey` at display
// time rather than this function resolving and baking in a library title.
async function failPendingSyncsMatching(extraWhere: SQL, reason: string): Promise<void> {
  const finishedAt = Math.floor(Date.now() / 1000);
  const error = `interrupted — ${reason}`;
  const rows = await db.update(syncLog)
    .set({ status: 'error', finishedAt, error })
    .where(and(eq(syncLog.status, 'pending'), extraWhere))
    .returning({ id: syncLog.id, serverId: syncLog.serverId, libraryKey: syncLog.libraryKey });

  if (rows.length === 0) return;

  const eventInputs: LogEventInput[] = [];
  for (const row of rows) {
    if (row.serverId === null) continue;
    eventInputs.push({
      serverId: row.serverId,
      type: 'sync.failed',
      payload: { syncId: row.id, libraryKey: row.libraryKey, error },
    });
  }
  await logEvents(eventInputs);
}

// Called once at startup (main.ts) — a fresh boot means nothing can legitimately still
// be 'pending', so any such row was orphaned by a crash of the previous process.
export async function failAllPendingSyncs(): Promise<void> {
  await failPendingSyncsMatching(eq(syncLog.status, 'pending'), 'server restarted');
}

// Called hourly (and once at startup) — catches syncs that hung without crashing the
// process, so the pending conflict check doesn't block all future syncs forever.
// `excludeSyncIds` lets the caller protect syncIds it knows are still genuinely active
// in this process (see scheduler.ts's sweepStalePendingRows) from being marked 'error'
// purely for having run a long time.
export async function failStalePendingSyncs(
  olderThanSeconds: number,
  excludeSyncIds: number[] = [],
): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
  const where = excludeSyncIds.length > 0
    ? and(lt(syncLog.startedAt, cutoff), notInArray(syncLog.id, excludeSyncIds))!
    : lt(syncLog.startedAt, cutoff);
  await failPendingSyncsMatching(
    where,
    `no progress for over ${formatRoughDuration(olderThanSeconds)}`,
  );
}

// Pure sync logic — throws on error, returns total items processed.
// plex/serverId are resolved once by the caller (syncManager's triggerFullSync) and
// threaded through here rather than re-resolved, so this always operates on the exact
// server the sync_log row was created for even if the active server changes mid-run.
// The caller (syncManager's runSyncTask) is responsible for try/catch and finalizeSyncLog.
export async function runSync(
  plex: PlexClient,
  serverId: number,
  reporter?: SyncReporter,
): Promise<number> {
  const plexLibraries = await plex.libraries();
  const now = Math.floor(Date.now() / 1000);

  reporter?.onLibraries?.(plexLibraries.map((l) => ({ key: l.key, title: l.title })));

  // Plex has no deletion events for whole sections, so a full sync is the
  // only place a library removed from Plex is ever detected — prune it here, which cascades
  // to its items/seasons via their FK onDelete('cascade'). Guarded on a non-empty response:
  // if Plex reports zero libraries, that's far more likely a transient glitch than every
  // library having been deleted, and wiping everything on a blip would be catastrophic.
  if (plexLibraries.length > 0) {
    await db.delete(libraries).where(
      and(
        eq(libraries.serverId, serverId),
        notInArray(libraries.key, plexLibraries.map((l) => l.key)),
      ),
    );
  }

  let totalItems = 0;

  // Worker pool: each worker pulls the next library off the shared queue as soon as
  // it finishes its current one, instead of waiting for a whole fixed-size batch to drain.
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < plexLibraries.length) {
      const lib = plexLibraries[nextIndex++];
      await syncLibrary(
        plex,
        lib,
        now,
        serverId,
        buildCallbacks(reporter, lib.key, (d) => {
          totalItems += d;
        }),
      );
    }
  }

  const workerCount = Math.min(LIBRARY_SYNC_CONCURRENCY, plexLibraries.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  return totalItems;
}

// Pure sync logic for a single library — throws on error, returns items processed.
// plex/serverId are resolved once by the caller (syncManager's triggerLibrarySync) and
// threaded through here — see runSync() above for why.
// The caller (syncManager's runSyncTask) is responsible for try/catch and finalizeSyncLog.
export async function runLibrarySync(
  plex: PlexClient,
  serverId: number,
  libraryKey: string,
  reporter?: SyncReporter,
): Promise<number> {
  const [lib] = await db
    .select({ key: libraries.key, title: libraries.title, type: libraries.type })
    .from(libraries)
    .where(libraryByKey(serverId, libraryKey))
    .limit(1);
  if (!lib) throw new Error(`Library ${libraryKey} not found`);

  reporter?.onLibraries?.([{ key: lib.key, title: lib.title }]);

  const now = Math.floor(Date.now() / 1000);
  let itemCount = 0;
  await syncLibrary(
    plex,
    lib,
    now,
    serverId,
    buildCallbacks(reporter, libraryKey, (d) => {
      itemCount += d;
    }),
  );
  return itemCount;
}
