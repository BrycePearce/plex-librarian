import { and, asc, eq, gt, lt, notInArray, sql } from 'drizzle-orm';
import { SQLITE_WRITE_BATCH_ROWS, sqliteWriteBatches } from '../../db/batch.ts';
import { db, withTransaction } from '../../db/index.ts';
import { episodeMediaVersions, items, seasons } from '../../db/schema.ts';
import { episodeVersionsByLibrary, seasonsByLibrary } from '../../db/scope.ts';
import type {
  PlexClient,
  PlexEpisodeMediaVersion,
  PlexLibrary,
} from '../../integrations/plex/index.ts';
import { auditSeasonIndexes, EpisodeRangeSet } from './episodeRanges.ts';

const excl = (column: { name: string }) => sql.raw(`excluded.${column.name}`);

// A whole season is safe to classify by age only when every member contributes an
// addition timestamp. Ignoring an unknown episode would let an older known sibling
// make the entire season look stale.
export function conservativeSeasonAddedAt(
  current: number | null,
  next: number | null,
): number | null {
  return current === null || next === null ? null : Math.max(current, next);
}

// Streams all episodes for a TV library, aggregates file sizes by season in a
// bounded map (entries ≈ shows × avg-seasons, not episode count), then upserts
// into the seasons table and rolls totals up to the show-level items row.
export async function syncShowSizes(
  plex: PlexClient,
  lib: PlexLibrary,
  now: number,
  serverId: number,
  preserveDeletionProjections = false,
  protectedShowRatingKeys: readonly string[] = [],
  suppressAllProjectionPruning = preserveDeletionProjections &&
    protectedShowRatingKeys.length === 0,
): Promise<{ pruneCompleted: boolean }> {
  type SeasonAgg = {
    showRatingKey: string;
    seasonIndex: number;
    title: string;
    addedAt: number | null;
    lastViewedAt: number | null;
    fileSize: number;
    duration: number;
    leafCount: number;
    viewCount: number;
    episodeRanges: EpisodeRangeSet;
  };
  // The map accumulates across all episode pages before any upsert. This is intentional:
  // a season's episodes are not guaranteed to arrive contiguously across pages, so we
  // can't upsert a season's totals until the entire episode stream is exhausted. The map
  // is bounded by shows × avg-seasons (not episode count) — for a 10k-show library with
  // ~5 seasons each that's ~50k entries, well within acceptable memory.
  const seasonMap = new Map<string, SeasonAgg>();
  const conflictingShowRatingKeys = new Set<string>();
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
        if (agg.showRatingKey !== ep.showRatingKey || agg.seasonIndex !== ep.seasonIndex) {
          agg.episodeRanges.invalidate('conflicting_season_identity');
          conflictingShowRatingKeys.add(agg.showRatingKey);
          conflictingShowRatingKeys.add(ep.showRatingKey);
        } else {
          agg.episodeRanges.insert(ep.episodeIndex);
        }
        agg.fileSize += ep.fileSize ?? 0;
        agg.duration += ep.duration ?? 0;
        agg.leafCount += 1;
        agg.viewCount += ep.viewCount;
        agg.addedAt = conservativeSeasonAddedAt(agg.addedAt, ep.addedAt);
        if (ep.lastViewedAt !== null) {
          agg.lastViewedAt = Math.max(agg.lastViewedAt ?? ep.lastViewedAt, ep.lastViewedAt);
        }
      } else {
        const episodeRanges = new EpisodeRangeSet();
        episodeRanges.insert(ep.episodeIndex);
        seasonMap.set(ep.seasonRatingKey, {
          showRatingKey: ep.showRatingKey,
          seasonIndex: ep.seasonIndex,
          title: ep.seasonTitle,
          addedAt: ep.addedAt,
          lastViewedAt: ep.lastViewedAt,
          fileSize: ep.fileSize ?? 0,
          duration: ep.duration ?? 0,
          leafCount: 1,
          viewCount: ep.viewCount,
          episodeRanges,
        });
      }
    }
    episodeVersions.push(...page.episodeMediaVersions);
  }

  // No episodes fetched — transient empty response or all filtered. Skip prune and
  // rollup to preserve existing season data rather than wiping it. Mirrors the
  // hasItems guard on the items prune in syncLibrary.
  if (seasonMap.size === 0) return { pruneCompleted: false };

  const entries = [...seasonMap.entries()];
  for (const batch of sqliteWriteBatches(entries)) {
    await db
      .insert(seasons)
      .values(
        batch.map(([ratingKey, agg]) => {
          const audit = agg.episodeRanges.finish(agg.seasonIndex);
          return ({
            serverId,
            ratingKey,
            showRatingKey: agg.showRatingKey,
            libraryKey: lib.key,
            seasonIndex: agg.seasonIndex,
            title: agg.title,
            addedAt: agg.addedAt,
            lastViewedAt: agg.lastViewedAt,
            fileSize: agg.fileSize > 0 ? agg.fileSize : null,
            duration: agg.duration > 0 ? agg.duration : null,
            leafCount: agg.leafCount,
            viewCount: agg.viewCount,
            episodeFirstIndex: audit.firstIndex,
            episodeLastIndex: audit.lastIndex,
            episodePresentCount: audit.presentCount,
            episodeGapCount: audit.gapCount,
            episodeGapRangesJson: audit.gapRanges ? JSON.stringify(audit.gapRanges) : null,
            episodeAuditStatus: audit.status,
            episodeAuditReason: audit.reason,
            updatedAt: now,
          });
        }),
      )
      .onConflictDoUpdate({
        target: [seasons.serverId, seasons.ratingKey],
        set: {
          showRatingKey: excl(seasons.showRatingKey),
          libraryKey: excl(seasons.libraryKey),
          seasonIndex: excl(seasons.seasonIndex),
          title: excl(seasons.title),
          addedAt: excl(seasons.addedAt),
          lastViewedAt: sql`CASE
            WHEN ${seasons.lastViewedAt} IS NULL THEN ${excl(seasons.lastViewedAt)}
            WHEN ${excl(seasons.lastViewedAt)} IS NULL THEN ${seasons.lastViewedAt}
            ELSE MAX(${seasons.lastViewedAt}, ${excl(seasons.lastViewedAt)})
          END`,
          fileSize: excl(seasons.fileSize),
          duration: excl(seasons.duration),
          leafCount: excl(seasons.leafCount),
          viewCount: excl(seasons.viewCount),
          episodeFirstIndex: excl(seasons.episodeFirstIndex),
          episodeLastIndex: excl(seasons.episodeLastIndex),
          episodePresentCount: excl(seasons.episodePresentCount),
          episodeGapCount: excl(seasons.episodeGapCount),
          episodeGapRangesJson: excl(seasons.episodeGapRangesJson),
          episodeAuditStatus: excl(seasons.episodeAuditStatus),
          episodeAuditReason: excl(seasons.episodeAuditReason),
          updatedAt: excl(seasons.updatedAt),
        },
      });
  }

  const seasonIndexesByShow = new Map<string, number[]>();
  for (const [, agg] of entries) {
    const indexes = seasonIndexesByShow.get(agg.showRatingKey) ?? [];
    indexes.push(agg.seasonIndex);
    seasonIndexesByShow.set(agg.showRatingKey, indexes);
  }
  const protectedShows = new Set(protectedShowRatingKeys);
  let afterRatingKey: string | null = null;
  while (true) {
    const currentShows = await db.select({ ratingKey: items.ratingKey }).from(items).where(and(
      eq(items.serverId, serverId),
      eq(items.libraryKey, lib.key),
      eq(items.type, 'show'),
      eq(items.updatedAt, now),
      afterRatingKey === null ? undefined : gt(items.ratingKey, afterRatingKey),
    )).orderBy(asc(items.ratingKey)).limit(SQLITE_WRITE_BATCH_ROWS);
    if (currentShows.length === 0) break;
    withTransaction((client) => {
      const statement = client.prepare(`
        UPDATE items SET
          season_first_index = ?, season_last_index = ?, season_present_count = ?,
          season_gap_count = ?, season_gap_ranges_json = ?, season_audit_status = ?,
          season_audit_reason = ?
        WHERE server_id = ? AND library_key = ? AND rating_key = ? AND type = 'show'
      `);
      for (const show of currentShows) {
        if (suppressAllProjectionPruning || protectedShows.has(show.ratingKey)) continue;
        const audit = auditSeasonIndexes(
          seasonIndexesByShow.get(show.ratingKey) ?? [],
          conflictingShowRatingKeys.has(show.ratingKey),
        );
        statement.run(
          audit.firstIndex,
          audit.lastIndex,
          audit.presentCount,
          audit.gapCount,
          audit.gapRanges ? JSON.stringify(audit.gapRanges) : null,
          audit.status,
          audit.reason,
          serverId,
          lib.key,
          show.ratingKey,
        );
      }
    });
    afterRatingKey = currentShows.at(-1)!.ratingKey;
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
          videoBitDepth: sql`CASE WHEN ${excl(episodeMediaVersions.streamDetailsAvailable)} THEN ${
            excl(episodeMediaVersions.videoBitDepth)
          } ELSE ${episodeMediaVersions.videoBitDepth} END`,
          videoDynamicRange: excl(episodeMediaVersions.videoDynamicRange),
          videoFrameRate: excl(episodeMediaVersions.videoFrameRate),
          videoScanType: sql`CASE WHEN ${excl(episodeMediaVersions.streamDetailsAvailable)} THEN ${
            excl(episodeMediaVersions.videoScanType)
          } ELSE ${episodeMediaVersions.videoScanType} END`,
          container: excl(episodeMediaVersions.container),
          audioCodec: excl(episodeMediaVersions.audioCodec),
          audioChannels: excl(episodeMediaVersions.audioChannels),
          audioProfile: excl(episodeMediaVersions.audioProfile),
          audioStreamsJson: sql`CASE WHEN ${
            excl(episodeMediaVersions.streamDetailsAvailable)
          } THEN ${
            excl(episodeMediaVersions.audioStreamsJson)
          } ELSE ${episodeMediaVersions.audioStreamsJson} END`,
          subtitleStreamsJson: sql`CASE WHEN ${
            excl(episodeMediaVersions.streamDetailsAvailable)
          } THEN ${
            excl(episodeMediaVersions.subtitleStreamsJson)
          } ELSE ${episodeMediaVersions.subtitleStreamsJson} END`,
          streamDetailsAvailable: sql`${episodeMediaVersions.streamDetailsAvailable} OR ${
            excl(episodeMediaVersions.streamDetailsAvailable)
          }`,
          fileSize: excl(episodeMediaVersions.fileSize),
          updatedAt: excl(episodeMediaVersions.updatedAt),
        },
      });
  }

  // Needs-attention deletion recovery owns its affected show/episode roots until manual
  // replay finalizes them. Excluding the same roots from both prunes prevents the season
  // FK cascade from deleting a protected episode-version row indirectly.
  if (!suppressAllProjectionPruning) {
    await db
      .delete(seasons)
      .where(and(
        seasonsByLibrary(serverId, lib.key),
        lt(seasons.updatedAt, now),
        ...(protectedShowRatingKeys.length > 0
          ? [notInArray(seasons.showRatingKey, [...protectedShowRatingKeys])]
          : []),
      ));

    // Runs after the seasons prune (not before) purely to avoid redundant work: any
    // episode-version row belonging to a show/season pruned above is already
    // cascade-deleted by that prune (both showRatingKey->items and
    // seasonRatingKey->seasons cascade). This explicit prune only catches the remaining
    // case — the show/season still exists, but a specific episode version disappeared
    // from Plex between syncs.
    await db.delete(episodeMediaVersions).where(and(
      episodeVersionsByLibrary(serverId, lib.key),
      lt(episodeMediaVersions.updatedAt, now),
      ...(protectedShowRatingKeys.length > 0
        ? [notInArray(episodeMediaVersions.showRatingKey, [...protectedShowRatingKeys])]
        : []),
    ));
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
  return { pruneCompleted: !preserveDeletionProjections };
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
