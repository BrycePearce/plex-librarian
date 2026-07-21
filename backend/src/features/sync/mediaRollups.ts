import { and, lt, sql } from 'drizzle-orm';
import { sqliteWriteBatches } from '../../db/batch.ts';
import { db, withTransaction } from '../../db/index.ts';
import { episodeMediaVersions, seasons } from '../../db/schema.ts';
import { episodeVersionsByLibrary, seasonsByLibrary } from '../../db/scope.ts';
import type {
  PlexClient,
  PlexEpisodeMediaVersion,
  PlexLibrary,
} from '../../integrations/plex/index.ts';

const excl = (column: { name: string }) => sql.raw(`excluded.${column.name}`);

// Streams all episodes for a TV library, aggregates file sizes by season in a
// bounded map (entries ≈ shows × avg-seasons, not episode count), then upserts
// into the seasons table and rolls totals up to the show-level items row.
export async function syncShowSizes(
  plex: PlexClient,
  lib: PlexLibrary,
  now: number,
  serverId: number,
  preserveDeletionProjections = false,
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
  for (const batch of sqliteWriteBatches(entries)) {
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
  for (const batch of sqliteWriteBatches(episodeVersions)) {
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
          width: excl(episodeMediaVersions.width),
          height: excl(episodeMediaVersions.height),
          duration: excl(episodeMediaVersions.duration),
          bitrate: excl(episodeMediaVersions.bitrate),
          videoCodec: excl(episodeMediaVersions.videoCodec),
          videoProfile: excl(episodeMediaVersions.videoProfile),
          videoBitDepth: excl(episodeMediaVersions.videoBitDepth),
          videoDynamicRange: excl(episodeMediaVersions.videoDynamicRange),
          videoFrameRate: excl(episodeMediaVersions.videoFrameRate),
          videoScanType: excl(episodeMediaVersions.videoScanType),
          container: excl(episodeMediaVersions.container),
          audioCodec: excl(episodeMediaVersions.audioCodec),
          audioChannels: excl(episodeMediaVersions.audioChannels),
          audioProfile: excl(episodeMediaVersions.audioProfile),
          audioStreamsJson: excl(episodeMediaVersions.audioStreamsJson),
          subtitleStreamsJson: excl(episodeMediaVersions.subtitleStreamsJson),
          streamDetailsAvailable: excl(episodeMediaVersions.streamDetailsAvailable),
          fileSize: excl(episodeMediaVersions.fileSize),
          updatedAt: excl(episodeMediaVersions.updatedAt),
        },
      });
  }

  // Needs-attention deletion recovery owns its existing show/episode projection until
  // manual replay finalizes it. Skipping both prunes together also prevents the season
  // FK cascade from deleting a protected episode-version row indirectly.
  if (!preserveDeletionProjections) {
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
  }

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
export async function syncArtistSizes(
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
