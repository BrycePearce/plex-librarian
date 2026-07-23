import { and, eq, lt, notInArray, sql } from 'drizzle-orm';
import { sqliteWriteBatches } from '../../db/batch.ts';
import { db, withTransaction } from '../../db/index.ts';
import { itemMediaVersions, items, libraries, servers } from '../../db/schema.ts';
import { itemsByLibrary, libraryByKey, mediaVersionsByLibrary } from '../../db/scope.ts';
import {
  deletionRecoveryLibraryKeys,
  deletionRecoveryNeedsProjection,
} from '../deletionOperations/coordination.ts';
import { PLEX_TYPE } from '../../integrations/plex/index.ts';
import type { PlexClient, PlexLibrary } from '../../integrations/plex/index.ts';
import { syncLibraryHistory } from './historySync.ts';
import { syncArtistSizes, syncShowSizes } from './mediaRollups.ts';
import { syncUsers } from './userSync.ts';
import { withLibraryOperation } from '../../services/libraryOperations.ts';
import { syncSeerrRequests } from '../seerr/sync.ts';
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

async function stageLibraryHistoryCoverage(
  plexLibraries: PlexLibrary[],
  serverId: number,
  now: number,
): Promise<void> {
  for (const batch of sqliteWriteBatches(plexLibraries)) {
    await db.insert(libraries)
      .values(batch.map((lib) => ({
        serverId,
        key: lib.key,
        title: lib.title,
        type: lib.type,
        syncedAt: now,
        historySyncedAt: null,
      })))
      .onConflictDoUpdate({
        target: [libraries.serverId, libraries.key],
        set: {
          title: excl(libraries.title),
          type: excl(libraries.type),
          syncedAt: excl(libraries.syncedAt),
          historySyncedAt: null,
        },
      });
  }
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
    for (const batch of sqliteWriteBatches(page.items)) {
      await db
        .insert(items)
        .values(
          batch.map((item) => ({
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
            tmdbId: item.tmdbId,
            tvdbId: item.tvdbId,
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
            tmdbId: excl(items.tmdbId),
            tvdbId: excl(items.tvdbId),
            updatedAt: excl(items.updatedAt),
          },
        });
    }
    itemCount += page.items.length;
    callbacks?.onCount(page.items.length);

    // Items must be upserted before their media versions within this same page — the
    // FK(server_id, item_rating_key) → items(server_id, rating_key) needs the parent
    // row to already exist. Only ever non-empty for movie libraries (see libraryItems).
    for (const batch of sqliteWriteBatches(page.mediaVersions)) {
      await db
        .insert(itemMediaVersions)
        .values(
          batch.map((v) => ({
            serverId,
            mediaId: v.mediaId,
            itemRatingKey: v.itemRatingKey,
            libraryKey: lib.key,
            videoResolution: v.videoResolution,
            width: v.width,
            height: v.height,
            duration: v.duration,
            bitrate: v.bitrate,
            videoCodec: v.videoCodec,
            videoProfile: v.videoProfile,
            videoBitDepth: v.videoBitDepth,
            videoDynamicRange: v.videoDynamicRange,
            videoFrameRate: v.videoFrameRate,
            videoScanType: v.videoScanType,
            container: v.container,
            audioCodec: v.audioCodec,
            audioChannels: v.audioChannels,
            audioProfile: v.audioProfile,
            audioStreamsJson: JSON.stringify(v.audioStreams),
            subtitleStreamsJson: JSON.stringify(v.subtitleStreams),
            streamDetailsAvailable: v.streamDetailsAvailable,
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
            width: excl(itemMediaVersions.width),
            height: excl(itemMediaVersions.height),
            duration: excl(itemMediaVersions.duration),
            bitrate: excl(itemMediaVersions.bitrate),
            videoCodec: excl(itemMediaVersions.videoCodec),
            videoProfile: excl(itemMediaVersions.videoProfile),
            videoBitDepth: sql`CASE WHEN ${excl(itemMediaVersions.streamDetailsAvailable)} THEN ${
              excl(itemMediaVersions.videoBitDepth)
            } ELSE ${itemMediaVersions.videoBitDepth} END`,
            videoDynamicRange: excl(itemMediaVersions.videoDynamicRange),
            videoFrameRate: excl(itemMediaVersions.videoFrameRate),
            videoScanType: sql`CASE WHEN ${excl(itemMediaVersions.streamDetailsAvailable)} THEN ${
              excl(itemMediaVersions.videoScanType)
            } ELSE ${itemMediaVersions.videoScanType} END`,
            container: excl(itemMediaVersions.container),
            audioCodec: excl(itemMediaVersions.audioCodec),
            audioChannels: excl(itemMediaVersions.audioChannels),
            audioProfile: excl(itemMediaVersions.audioProfile),
            audioStreamsJson: sql`CASE WHEN ${
              excl(itemMediaVersions.streamDetailsAvailable)
            } THEN ${
              excl(itemMediaVersions.audioStreamsJson)
            } ELSE ${itemMediaVersions.audioStreamsJson} END`,
            subtitleStreamsJson: sql`CASE WHEN ${
              excl(itemMediaVersions.streamDetailsAvailable)
            } THEN ${
              excl(itemMediaVersions.subtitleStreamsJson)
            } ELSE ${itemMediaVersions.subtitleStreamsJson} END`,
            streamDetailsAvailable: sql`${itemMediaVersions.streamDetailsAvailable} OR ${
              excl(itemMediaVersions.streamDetailsAvailable)
            }`,
            fileSize: excl(itemMediaVersions.fileSize),
            updatedAt: excl(itemMediaVersions.updatedAt),
          },
        });
    }
  }

  // A needs-attention deletion is terminal for worker scheduling but still owns its
  // local projection until manual replay finalizes it. Continue refreshing the library,
  // but suppress every prune for this pass so sync cannot split that finalization.
  const preserveDeletionProjections = withTransaction((client) =>
    deletionRecoveryNeedsProjection(client, serverId, lib.key)
  );

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
    await syncShowSizes(plex, lib, now, serverId, preserveDeletionProjections);
  } else if (lib.type === 'artist') {
    callbacks?.onPhase('tracks');
    await syncArtistSizes(plex, lib, serverId);
  }

  if (itemCount > 0 && !preserveDeletionProjections) {
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

// Pure sync logic — throws on error, returns total items processed.
// plex/serverId are resolved once by the caller (manager.ts's triggerFullSync) and
// threaded through here rather than re-resolved, so this always operates on the exact
// server the sync_log row was created for even if the active server changes mid-run.
// The caller (manager.ts's runSyncTask) is responsible for try/catch and finalizeSyncLog.
export async function runSync(
  plex: PlexClient,
  serverId: number,
  reporter?: SyncReporter,
): Promise<number> {
  // Invalidate every coverage marker before the first Plex request. Failures in
  // libraries() or roster reconciliation must not leave a previous successful run
  // publicly classified as current, especially for request follow-through.
  await Promise.all([
    db.update(servers).set({ usersSyncedAt: null }).where(eq(servers.id, serverId)),
    db.update(libraries).set({ historySyncedAt: null }).where(and(
      eq(libraries.serverId, serverId),
      sql`${libraries.type} <> 'artist'`,
    )),
  ]);
  const plexLibraries = await plex.libraries();
  const now = Math.floor(Date.now() / 1000);

  reporter?.onLibraries?.(plexLibraries.map((l) => ({ key: l.key, title: l.title })));

  // Plex has no deletion events for whole sections, so a full sync is the
  // only place a library removed from Plex is ever detected — prune it here, which cascades
  // to its items/seasons via their FK onDelete('cascade'). Guarded on a non-empty response:
  // if Plex reports zero libraries, that's far more likely a transient glitch than every
  // library having been deleted, and wiping everything on a blip would be catastrophic.
  if (plexLibraries.length > 0) {
    const retainedLibraryKeys = new Set(plexLibraries.map((library) => library.key));
    for (
      const libraryKey of withTransaction((client) => deletionRecoveryLibraryKeys(client, serverId))
    ) {
      retainedLibraryKeys.add(libraryKey);
    }
    await db.delete(libraries).where(
      and(
        eq(libraries.serverId, serverId),
        notInArray(libraries.key, [...retainedLibraryKeys]),
      ),
    );
  }

  // Publish every discovered video library as history-pending before user identity
  // coverage can become complete. Without this staging pass, a first-ever sync has a
  // window where the database contains no video rows and the music-only empty-set rule
  // can incorrectly classify users as never watched.
  await stageLibraryHistoryCoverage(plexLibraries, serverId, now);

  // Roster is a per-server concern, not per-library — refresh it once, before any
  // library's own syncLibraryHistory call needs already-reconciled local account ids
  // to attribute activity to (see syncUsers' comment above).
  await syncUsers(plex, serverId, now);

  let totalItems = 0;

  // Worker pool: each worker pulls the next library off the shared queue as soon as
  // it finishes its current one, instead of waiting for a whole fixed-size batch to drain.
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < plexLibraries.length) {
      const lib = plexLibraries[nextIndex++];
      await withLibraryOperation(serverId, lib.key, 'sync', () =>
        syncLibrary(
          plex,
          lib,
          now,
          serverId,
          buildCallbacks(reporter, lib.key, (d) => {
            totalItems += d;
          }),
        ));
    }
  }

  const workerCount = Math.min(LIBRARY_SYNC_CONCURRENCY, plexLibraries.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  await syncSeerrRequests(serverId, now);

  return totalItems;
}

// Pure sync logic for a single library — throws on error, returns items processed.
// plex/serverId are resolved once by the caller (manager.ts's triggerLibrarySync) and
// threaded through here — see runSync() above for why.
// The caller (manager.ts's runSyncTask) is responsible for try/catch and finalizeSyncLog.
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

  if (lib.type !== 'artist') {
    await db.update(libraries).set({ historySyncedAt: null }).where(
      libraryByKey(serverId, libraryKey),
    );
  }

  reporter?.onLibraries?.([{ key: lib.key, title: lib.title }]);

  const now = Math.floor(Date.now() / 1000);

  // A library-only sync uses the last confirmed identity mappings. Publishing a newer
  // server-wide reconciliation here would make every other video library's older
  // history generation incomplete until a full sync walked them as well.

  let itemCount = 0;
  await withLibraryOperation(serverId, libraryKey, 'sync', () =>
    syncLibrary(
      plex,
      lib,
      now,
      serverId,
      buildCallbacks(reporter, libraryKey, (d) => {
        itemCount += d;
      }),
    ));
  return itemCount;
}
