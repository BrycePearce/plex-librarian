import { type SqliteClient, withTransaction } from '../../db/index.ts';
import type {
  StaleQuickCleanupCandidate,
  StaleQuickCleanupOrder,
  StaleQuickCleanupResponse,
  StaleQuickCleanupSort,
} from '@plex-librarian/shared/types.ts';
import { STALE_QUICK_CLEANUP_LIMIT } from './quickCleanupRules.ts';
import { workflowOwnedItemSql } from '../deletionOperations/core/ownership.ts';
export {
  parseStaleQuickCleanupDays,
  STALE_QUICK_CLEANUP_DEFAULT_DAYS,
} from './quickCleanupRules.ts';

const DAY_SECONDS = 86_400;

interface LibraryState {
  type: string;
  historySyncedAt: number | null;
}

export interface StaleQuickCleanupProtection {
  ratingKeys: Set<string>;
  count: number;
  fileSize: number;
  unknownSizeCount: number;
}

function duplicateSql(type: string): string {
  return type === 'movie'
    ? `EXISTS (
        SELECT 1 FROM item_media_versions versions
        WHERE versions.server_id = i.server_id
          AND versions.library_key = i.library_key
          AND versions.item_rating_key = i.rating_key
        GROUP BY versions.item_rating_key
        HAVING COUNT(*) >= 2
      )`
    : `EXISTS (
        SELECT 1 FROM episode_media_versions versions
        WHERE versions.server_id = i.server_id
          AND versions.library_key = i.library_key
          AND versions.show_rating_key = i.rating_key
      )`;
}

const recentRequestSql = `EXISTS (
  SELECT 1 FROM seerr_requests request
  WHERE request.server_id = i.server_id
    AND request.rating_key = i.rating_key
    AND request.request_status IN (2, 5)
    AND request.requested_at >= ?
)`;

const inactiveSql = `(
  (i.last_viewed_at IS NULL AND i.added_at IS NOT NULL AND i.added_at < ?)
  OR i.last_viewed_at < ?
)`;

function libraryState(
  client: SqliteClient,
  serverId: number,
  libraryKey: string,
): LibraryState | null {
  const row = client.prepare(
    'SELECT type, history_synced_at FROM libraries WHERE server_id = ? AND key = ?',
  ).value<[string, number | null]>(serverId, libraryKey);
  return row ? { type: row[0], historySyncedAt: row[1] } : null;
}

function emptyResponse(
  thresholdDays: number,
  historySyncedAt: number | null,
  unavailableReason: StaleQuickCleanupResponse['unavailableReason'],
): StaleQuickCleanupResponse {
  return {
    thresholdDays,
    historySyncedAt,
    eligible: false,
    unavailableReason,
    candidateTotal: 0,
    candidateFileSize: 0,
    unknownSizeCount: 0,
    duplicateProtectedCount: 0,
    recentRequestProtectedCount: 0,
    activePlaybackProtectedCount: 0,
    limit: STALE_QUICK_CLEANUP_LIMIT,
    candidates: [],
  };
}

type CandidateRow = [
  string,
  string,
  string,
  string,
  string | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number,
];

function candidateFromRow(row: CandidateRow): StaleQuickCleanupCandidate {
  const lastViewedAt = row[6];
  const addedAt = row[5];
  const inactiveSince = lastViewedAt ?? addedAt!;
  return {
    ratingKey: row[0],
    libraryKey: row[1],
    title: row[2],
    type: row[3],
    thumb: row[4],
    addedAt,
    lastViewedAt,
    viewCount: row[7],
    fileSize: row[8],
    duration: row[9],
    year: row[10],
    updatedAt: row[11],
    reason: lastViewedAt === null ? 'never-watched' : 'long-dormant',
    inactiveSince,
  };
}

export function analyzeStaleQuickCleanup(
  serverId: number,
  libraryKey: string,
  thresholdDays: number,
  now = Math.floor(Date.now() / 1000),
  excludedRatingKeys: readonly string[] = [],
  sort: StaleQuickCleanupSort = 'fileSize',
  order: StaleQuickCleanupOrder = 'desc',
): StaleQuickCleanupResponse | null {
  return withTransaction((client) => {
    const library = libraryState(client, serverId, libraryKey);
    if (!library) return null;
    if (library.type !== 'movie' && library.type !== 'show') {
      return emptyResponse(thresholdDays, library.historySyncedAt, 'unsupported-library');
    }
    if (library.historySyncedAt === null) {
      return emptyResponse(thresholdDays, null, 'history-incomplete');
    }

    const cutoff = now - thresholdDays * DAY_SECONDS;
    const duplicate = duplicateSql(library.type);
    const workflowOwned = workflowOwnedItemSql(library.type);
    const baseParams = [serverId, libraryKey, cutoff, cutoff] as const;
    const excludedSql = excludedRatingKeys.length === 0
      ? ''
      : ` AND i.rating_key NOT IN (${excludedRatingKeys.map(() => '?').join(', ')})`;
    const includedSql = excludedRatingKeys.length === 0
      ? `NOT (${workflowOwned})`
      : `i.rating_key NOT IN (${excludedRatingKeys.map(() => '?').join(', ')})
        AND NOT (${workflowOwned})`;
    const eligibleSql =
      `${inactiveSql} AND NOT (${workflowOwned}) AND NOT (${duplicate}) AND NOT (${recentRequestSql})${excludedSql}`;
    const eligibleParams = [...baseParams, cutoff, ...excludedRatingKeys] as const;
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    const candidateOrder = sort === 'inactiveSince'
      // Older timestamps represent a longer inactive duration, so the SQL direction
      // is intentionally inverted relative to the user-facing elapsed-time order.
      ? `COALESCE(i.last_viewed_at, i.added_at) ${order === 'asc' ? 'DESC' : 'ASC'}`
      : `i.file_size IS NULL ASC, i.file_size ${direction}`;
    const stats = client.prepare(
      `WITH classified AS MATERIALIZED (
         SELECT i.file_size,
                (${duplicate}) AS duplicate_protected,
                (${recentRequestSql}) AS recent_request,
                (${includedSql}) AS included
         FROM items i
         WHERE i.server_id = ? AND i.library_key = ?
           AND ${inactiveSql}
       )
       SELECT
         SUM(CASE WHEN NOT duplicate_protected AND NOT recent_request AND included THEN 1 ELSE 0 END),
         CAST(COALESCE(SUM(
           CASE WHEN NOT duplicate_protected AND NOT recent_request AND included
             THEN file_size ELSE 0 END
         ), 0) AS TEXT),
         SUM(CASE WHEN NOT duplicate_protected AND NOT recent_request AND included
                   AND file_size IS NULL THEN 1 ELSE 0 END),
         SUM(CASE WHEN duplicate_protected AND included THEN 1 ELSE 0 END),
         SUM(CASE WHEN NOT duplicate_protected AND recent_request AND included THEN 1 ELSE 0 END)
       FROM classified`,
    ).value<[number | null, string, number | null, number | null, number | null]>(
      cutoff,
      ...excludedRatingKeys,
      ...baseParams,
    );
    const rows = client.prepare(
      `WITH capped AS MATERIALIZED (
         SELECT i.rating_key, i.library_key, i.title, i.type, i.thumb, i.added_at,
                i.last_viewed_at, i.view_count, i.file_size, i.duration, i.year, i.updated_at
         FROM items i
         WHERE i.server_id = ? AND i.library_key = ?
           AND ${eligibleSql}
         ORDER BY i.file_size IS NULL ASC, i.file_size DESC,
                  i.title COLLATE NOCASE, i.rating_key
         LIMIT ?
       )
       SELECT i.rating_key, i.library_key, i.title, i.type, i.thumb, i.added_at,
              i.last_viewed_at, i.view_count, i.file_size, i.duration, i.year, i.updated_at
       FROM capped i
       ORDER BY ${candidateOrder}, i.title COLLATE NOCASE, i.rating_key`,
    ).values<CandidateRow>(...eligibleParams, STALE_QUICK_CLEANUP_LIMIT);

    return {
      thresholdDays,
      historySyncedAt: library.historySyncedAt,
      eligible: true,
      unavailableReason: null,
      candidateTotal: stats?.[0] ?? 0,
      candidateFileSize: Number(stats?.[1] ?? '0'),
      unknownSizeCount: stats?.[2] ?? 0,
      duplicateProtectedCount: stats?.[3] ?? 0,
      recentRequestProtectedCount: stats?.[4] ?? 0,
      activePlaybackProtectedCount: 0,
      limit: STALE_QUICK_CLEANUP_LIMIT,
      candidates: rows.map(candidateFromRow),
    };
  });
}

export function validateStaleQuickCleanupSelection(
  serverId: number,
  libraryKey: string,
  thresholdDays: number,
  ratingKeys: readonly string[],
  now = Math.floor(Date.now() / 1000),
): Map<string, StaleQuickCleanupCandidate> | null {
  return withTransaction((client) => {
    const library = libraryState(client, serverId, libraryKey);
    if (
      !library || library.historySyncedAt === null ||
      (library.type !== 'movie' && library.type !== 'show')
    ) {
      return null;
    }
    const cutoff = now - thresholdDays * DAY_SECONDS;
    const workflowOwned = workflowOwnedItemSql(library.type);
    const placeholders = ratingKeys.map(() => '?').join(', ');
    const rows = client.prepare(
      `SELECT i.rating_key, i.library_key, i.title, i.type, i.thumb, i.added_at,
              i.last_viewed_at, i.view_count, i.file_size, i.duration, i.year, i.updated_at
       FROM items i
       WHERE i.server_id = ? AND i.library_key = ?
         AND i.rating_key IN (${placeholders})
         AND ${inactiveSql}
         AND NOT (${workflowOwned})
         AND NOT (${duplicateSql(library.type)})
         AND NOT (${recentRequestSql})`,
    ).values<CandidateRow>(
      serverId,
      libraryKey,
      ...ratingKeys,
      cutoff,
      cutoff,
      cutoff,
    );
    const candidates = new Map(rows.map((row) => {
      const candidate = candidateFromRow(row);
      return [
        candidate.ratingKey,
        candidate,
      ] as const;
    }));
    return ratingKeys.every((ratingKey) => candidates.has(ratingKey)) ? candidates : null;
  });
}

export function isStaleQuickCleanupCandidate(
  serverId: number,
  libraryKey: string,
  thresholdDays: number,
  ratingKey: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  return withTransaction((client) => {
    const library = libraryState(client, serverId, libraryKey);
    if (
      !library || library.historySyncedAt === null ||
      (library.type !== 'movie' && library.type !== 'show')
    ) {
      return false;
    }
    const cutoff = now - thresholdDays * DAY_SECONDS;
    const workflowOwned = workflowOwnedItemSql(library.type);
    return client.prepare(
      `SELECT 1 FROM items i
       WHERE i.server_id = ? AND i.library_key = ? AND i.rating_key = ?
         AND ${inactiveSql}
         AND NOT (${workflowOwned})
         AND NOT (${duplicateSql(library.type)})
         AND NOT (${recentRequestSql})
       LIMIT 1`,
    ).value<[number]>(serverId, libraryKey, ratingKey, cutoff, cutoff, cutoff) !== undefined;
  });
}

export function staleQuickCleanupActiveProtection(
  serverId: number,
  libraryKey: string,
  thresholdDays: number,
  activeRatingKeys: ReadonlySet<string>,
  now = Math.floor(Date.now() / 1000),
): StaleQuickCleanupProtection {
  const empty = {
    ratingKeys: new Set<string>(),
    count: 0,
    fileSize: 0,
    unknownSizeCount: 0,
  };
  if (activeRatingKeys.size === 0) return empty;
  return withTransaction((client) => {
    const library = libraryState(client, serverId, libraryKey);
    if (
      !library || library.historySyncedAt === null ||
      (library.type !== 'movie' && library.type !== 'show')
    ) {
      return empty;
    }
    const cutoff = now - thresholdDays * DAY_SECONDS;
    const workflowOwned = workflowOwnedItemSql(library.type);
    const keys = [...activeRatingKeys];
    const placeholders = keys.map(() => '?').join(', ');
    const rows = client.prepare(
      `SELECT i.rating_key, i.file_size
       FROM items i
       WHERE i.server_id = ? AND i.library_key = ?
         AND i.rating_key IN (${placeholders})
         AND ${inactiveSql}
         AND NOT (${workflowOwned})
         AND NOT (${duplicateSql(library.type)})
         AND NOT (${recentRequestSql})`,
    ).values<[string, number | null]>(
      serverId,
      libraryKey,
      ...keys,
      cutoff,
      cutoff,
      cutoff,
    );
    return {
      ratingKeys: new Set(rows.map(([ratingKey]) => ratingKey)),
      count: rows.length,
      fileSize: rows.reduce((total, [, fileSize]) => total + (fileSize ?? 0), 0),
      unknownSizeCount: rows.filter(([, fileSize]) => fileSize === null).length,
    };
  });
}
