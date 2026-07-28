import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import { episodeMediaVersions, itemMediaVersions, items } from '../../db/schema.ts';
import { HAS_DUPLICATE_VERSIONS } from '../../db/scope.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import type { PlexMediaTechnicalDetails } from '../../integrations/plex/types.ts';
import { analyzeSmartDuplicateVersions } from '@plex-librarian/shared/smartDuplicateAnalysis.ts';
import type {
  SmartDuplicateAnalysisResponse,
  SmartDuplicateCandidate,
} from '@plex-librarian/shared/types.ts';
import { mediaVersionFromRow } from './mediaVersion.ts';
import { technicalDetailUpdate } from './technicalDetails.ts';

const READ_BATCH_SIZE = 400;
const READ_CONCURRENCY = 3;
// Keep one pass small enough for a low-footprint Unraid container and a usable
// confirmation dialog. The wider scan still finds high-value candidates without
// allowing one request to enqueue an unbounded durable deletion backlog.
export const SMART_CLEANUP_GROUP_LIMIT = 500;
export const SMART_CLEANUP_DELETE_IDS_LIMIT = 10;
const GROUP_SCAN_LIMIT_PER_MEDIA_TYPE = 4_000;
const TECHNICAL_ENRICHMENT_LIMIT = SMART_CLEANUP_GROUP_LIMIT;
const TECHNICAL_ENRICHMENT_CONCURRENCY = 4;

type MovieVersionRow = typeof itemMediaVersions.$inferSelect;
type EpisodeVersionRow = typeof episodeMediaVersions.$inferSelect;
type VersionRow = MovieVersionRow | EpisodeVersionRow;

interface ThinDuplicateGroup {
  mediaType: 'movie' | 'episode';
  ratingKey: string;
  totalSize: number;
  rows: VersionRow[];
}

function persistTechnicalDetails(
  serverId: number,
  group: ThinDuplicateGroup,
  details: Map<number, PlexMediaTechnicalDetails>,
): void {
  const table = group.mediaType === 'movie' ? 'item_media_versions' : 'episode_media_versions';
  const ratingColumn = group.mediaType === 'movie' ? 'item_rating_key' : 'episode_rating_key';
  withTransaction((client) => {
    const update = client.prepare(
      `UPDATE ${table}
       SET width = ?, height = ?, duration = ?, video_profile = ?, video_bit_depth = ?,
           video_dynamic_range = ?, video_frame_rate = ?, video_scan_type = ?,
           audio_codec = ?, audio_channels = ?, audio_profile = ?,
           audio_streams_json = ?, subtitle_streams_json = ?,
           stream_details_available = ?
       WHERE server_id = ? AND ${ratingColumn} = ? AND media_id = ?`,
    );
    for (const row of group.rows) {
      const detail = details.get(row.mediaId);
      if (!detail) continue;
      const values = technicalDetailUpdate(detail);
      const changed = update.run(
        values.width,
        values.height,
        values.duration,
        values.videoProfile,
        values.videoBitDepth,
        values.videoDynamicRange,
        values.videoFrameRate,
        values.videoScanType,
        values.audioCodec,
        values.audioChannels,
        values.audioProfile,
        values.audioStreamsJson,
        values.subtitleStreamsJson,
        values.streamDetailsAvailable ? 1 : 0,
        serverId,
        group.ratingKey,
        row.mediaId,
      );
      if (changed > 0) Object.assign(row, values);
    }
  });
}

async function enrichThinDuplicateGroups(
  serverId: number,
  movieVersions: Map<string, MovieVersionRow[]>,
  episodeVersions: Map<string, EpisodeVersionRow[]>,
): Promise<void> {
  const groups: ThinDuplicateGroup[] = [];
  for (const [ratingKey, rows] of movieVersions) {
    if (rows.some((row) => !row.streamDetailsAvailable)) {
      groups.push({
        mediaType: 'movie',
        ratingKey,
        totalSize: rows.reduce((total, row) => total + (row.fileSize ?? 0), 0),
        rows,
      });
    }
  }
  for (const [ratingKey, rows] of episodeVersions) {
    if (rows.some((row) => !row.streamDetailsAvailable)) {
      groups.push({
        mediaType: 'episode',
        ratingKey,
        totalSize: rows.reduce((total, row) => total + (row.fileSize ?? 0), 0),
        rows,
      });
    }
  }
  const selected = groups
    .sort((left, right) =>
      right.totalSize - left.totalSize ||
      left.mediaType.localeCompare(right.mediaType) ||
      left.ratingKey.localeCompare(right.ratingKey)
    )
    .slice(0, TECHNICAL_ENRICHMENT_LIMIT);
  if (selected.length === 0) return;

  const active = await resolveActiveServer();
  if (active.serverId !== serverId) return;
  const client = active.client;
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(TECHNICAL_ENRICHMENT_CONCURRENCY, selected.length) },
      async () => {
        while (nextIndex < selected.length) {
          const group = selected[nextIndex++]!;
          let details: Map<number, PlexMediaTechnicalDetails>;
          try {
            details = await client.mediaVersionTechnicalDetails(group.ratingKey);
          } catch {
            // A stale or temporarily unreadable Plex item stays protected. Other
            // independently verifiable groups should still be available for cleanup.
            continue;
          }
          persistTechnicalDetails(serverId, group, details);
        }
      },
    ),
  );
}

export function isValidSmartCleanupSelection(
  candidate: SmartDuplicateCandidate,
  deleteMediaIds: readonly number[],
): boolean {
  const candidateMediaIds = new Set(candidate.versions.map((version) => version.mediaId));
  return deleteMediaIds.length === candidate.versions.length - 1 &&
    new Set(deleteMediaIds).size === deleteMediaIds.length &&
    deleteMediaIds.every((mediaId) => candidateMediaIds.has(mediaId));
}

export function limitSmartDuplicateCandidates(
  candidates: readonly SmartDuplicateCandidate[],
): SmartDuplicateCandidate[] {
  return [...candidates].sort((left, right) =>
    Number(left.confidence === 'review') - Number(right.confidence === 'review') ||
    (right.reclaimableSize ?? 0) - (left.reclaimableSize ?? 0) ||
    left.title.localeCompare(right.title)
  ).slice(0, SMART_CLEANUP_GROUP_LIMIT);
}

function batches<T>(values: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += READ_BATCH_SIZE) {
    result.push(values.slice(index, index + READ_BATCH_SIZE));
  }
  return result;
}

async function loadInBatches<T>(
  keys: string[],
  load: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  const keyBatches = batches(keys);
  const pages: T[][] = new Array(keyBatches.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(READ_CONCURRENCY, keyBatches.length) },
      async () => {
        while (nextIndex < keyBatches.length) {
          const index = nextIndex++;
          pages[index] = await load(keyBatches[index]!);
        }
      },
    ),
  );
  return pages.flat();
}

export async function buildSmartDuplicateAnalysis(
  serverId: number,
  options: { movies: boolean; tv: boolean },
): Promise<SmartDuplicateAnalysisResponse> {
  const [movieGroups, episodeGroups] = await Promise.all([
    options.movies
      ? db.select({
        ratingKey: itemMediaVersions.itemRatingKey,
      })
        .from(itemMediaVersions)
        .where(eq(itemMediaVersions.serverId, serverId))
        .groupBy(itemMediaVersions.itemRatingKey)
        .having(HAS_DUPLICATE_VERSIONS)
        .orderBy(desc(sql`sum(${itemMediaVersions.fileSize})`))
        .limit(GROUP_SCAN_LIMIT_PER_MEDIA_TYPE)
      : Promise.resolve([]),
    options.tv
      ? db.select({
        ratingKey: episodeMediaVersions.episodeRatingKey,
      })
        .from(episodeMediaVersions)
        .where(eq(episodeMediaVersions.serverId, serverId))
        .groupBy(episodeMediaVersions.episodeRatingKey)
        .having(HAS_DUPLICATE_VERSIONS)
        .orderBy(desc(sql`sum(${episodeMediaVersions.fileSize})`))
        .limit(GROUP_SCAN_LIMIT_PER_MEDIA_TYPE)
      : Promise.resolve([]),
  ]);
  const movieKeys = movieGroups.map((group) => group.ratingKey);
  const episodeKeys = episodeGroups.map((group) => group.ratingKey);

  const [movieRows, episodeRows, movieItems] = await Promise.all([
    loadInBatches(movieKeys, (batch) =>
      db.select().from(itemMediaVersions).where(and(
        eq(itemMediaVersions.serverId, serverId),
        inArray(itemMediaVersions.itemRatingKey, batch),
      ))),
    loadInBatches(episodeKeys, (batch) =>
      db.select().from(episodeMediaVersions).where(and(
        eq(episodeMediaVersions.serverId, serverId),
        inArray(episodeMediaVersions.episodeRatingKey, batch),
      ))),
    loadInBatches(movieKeys, (batch) =>
      db.select({
        ratingKey: items.ratingKey,
        libraryKey: items.libraryKey,
        title: items.title,
        year: items.year,
      }).from(items).where(and(
        eq(items.serverId, serverId),
        inArray(items.ratingKey, batch),
      ))),
  ]);

  const showKeys = [...new Set(episodeRows.map((row) => row.showRatingKey))];
  const shows = await loadInBatches(showKeys, (batch) =>
    db.select({
      ratingKey: items.ratingKey,
      title: items.title,
    }).from(items).where(and(
      eq(items.serverId, serverId),
      inArray(items.ratingKey, batch),
    )));

  const movieItemByKey = new Map(movieItems.map((item) => [item.ratingKey, item]));
  const showByKey = new Map(shows.map((show) => [show.ratingKey, show]));
  const movieVersions = new Map<string, MovieVersionRow[]>();
  const episodeVersions = new Map<string, EpisodeVersionRow[]>();
  for (const row of movieRows) {
    const group = movieVersions.get(row.itemRatingKey) ?? [];
    group.push(row);
    movieVersions.set(row.itemRatingKey, group);
  }
  for (const row of episodeRows) {
    const group = episodeVersions.get(row.episodeRatingKey) ?? [];
    group.push(row);
    episodeVersions.set(row.episodeRatingKey, group);
  }
  await enrichThinDuplicateGroups(serverId, movieVersions, episodeVersions);

  const candidates: SmartDuplicateCandidate[] = [];
  for (const group of movieGroups) {
    const item = movieItemByKey.get(group.ratingKey);
    if (!item) continue;
    const versions = (movieVersions.get(group.ratingKey) ?? []).map(mediaVersionFromRow);
    if (versions.length - 1 > SMART_CLEANUP_DELETE_IDS_LIMIT) continue;
    const recommendation = analyzeSmartDuplicateVersions(versions);
    if (!recommendation) continue;
    candidates.push({
      mediaType: 'movie',
      libraryKey: item.libraryKey,
      ratingKey: group.ratingKey,
      title: item.title,
      context: item.year != null ? String(item.year) : null,
      versions,
      ...recommendation,
    });
  }
  for (const group of episodeGroups) {
    const rows = episodeVersions.get(group.ratingKey) ?? [];
    const first = rows[0];
    if (!first) continue;
    const versions = rows.map(mediaVersionFromRow);
    if (versions.length - 1 > SMART_CLEANUP_DELETE_IDS_LIMIT) continue;
    const recommendation = analyzeSmartDuplicateVersions(versions);
    if (!recommendation) continue;
    const show = showByKey.get(first.showRatingKey);
    candidates.push({
      mediaType: 'episode',
      libraryKey: first.libraryKey,
      ratingKey: group.ratingKey,
      title: show?.title ?? 'Unknown show',
      context: `S${first.seasonIndex}E${first.episodeIndex} · ${first.episodeTitle}`,
      versions,
      ...recommendation,
    });
  }

  const limitedCandidates = limitSmartDuplicateCandidates(candidates);
  const analyzedGroups = movieGroups.length + episodeGroups.length;
  return {
    analyzedGroups,
    protectedGroups: analyzedGroups - limitedCandidates.length,
    candidates: limitedCandidates,
  };
}
