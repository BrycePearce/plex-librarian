import type {
  EpisodeGapRange,
  EpisodeGapSeason,
  SeasonGapShow,
} from '@plex-librarian/shared/types.ts';

const IRREGULAR_REASONS = new Set([
  'invalid_episode_index',
  'episode_index_too_large',
  'invalid_season_index',
  'season_index_too_large',
  'range_limit_exceeded',
  'conflicting_season_identity',
]);
const SEASON_IRREGULAR_REASONS = new Set([
  'invalid_season_index',
  'season_index_too_large',
  'range_limit_exceeded',
  'conflicting_season_identity',
]);

export interface EpisodeGapProjectionRow {
  libraryKey: string;
  libraryTitle: string;
  showRatingKey: string;
  showTitle: string;
  showThumb: string | null;
  seasonRatingKey: string;
  seasonIndex: number;
  seasonTitle: string;
  firstEpisodeIndex: number | null;
  lastEpisodeIndex: number | null;
  presentCount: number | null;
  missingCount: number | null;
  missingRangesJson: string | null;
  status: string | null;
  reason: string | null;
  episodeAuditSyncedAt: number | null;
}

export interface SeasonGapProjectionRow {
  libraryKey: string;
  libraryTitle: string;
  showRatingKey: string;
  showTitle: string;
  showThumb: string | null;
  firstSeasonIndex: number | null;
  lastSeasonIndex: number | null;
  presentCount: number | null;
  missingCount: number | null;
  missingRangesJson: string | null;
  status: string | null;
  reason: string | null;
  episodeAuditSyncedAt: number | null;
}

export function decodeEpisodeGapProjection(row: EpisodeGapProjectionRow): EpisodeGapSeason {
  if (row.status === 'irregular' && IRREGULAR_REASONS.has(row.reason ?? '')) {
    return output(row, 'irregular', row.reason, []);
  }
  if (row.status !== 'ok' && row.status !== 'gaps') return invalid(row);
  if (
    !Number.isSafeInteger(row.seasonIndex) || row.seasonIndex <= 0 || row.seasonIndex > 10_000 ||
    !Number.isSafeInteger(row.firstEpisodeIndex) || !Number.isSafeInteger(row.lastEpisodeIndex) ||
    !Number.isSafeInteger(row.presentCount) || !Number.isSafeInteger(row.missingCount) ||
    row.firstEpisodeIndex! <= 0 || row.lastEpisodeIndex! < row.firstEpisodeIndex! ||
    row.presentCount! <= 0 || row.missingCount! < 0 ||
    row.lastEpisodeIndex! - row.firstEpisodeIndex! + 1 !== row.presentCount! + row.missingCount!
  ) return invalid(row);

  let ranges: EpisodeGapRange[];
  try {
    const parsed: unknown = JSON.parse(row.missingRangesJson ?? '');
    if (!Array.isArray(parsed) || parsed.length > 256) return invalid(row);
    ranges = parsed.map((range) => {
      if (
        typeof range !== 'object' || range === null ||
        !Number.isSafeInteger((range as EpisodeGapRange).start) ||
        !Number.isSafeInteger((range as EpisodeGapRange).end) ||
        (range as EpisodeGapRange).start <= 0 ||
        (range as EpisodeGapRange).end < (range as EpisodeGapRange).start
      ) throw new Error('invalid range');
      return { start: (range as EpisodeGapRange).start, end: (range as EpisodeGapRange).end };
    });
  } catch {
    return invalid(row);
  }
  let missing = 0;
  let previousEnd = 0;
  for (const range of ranges) {
    if (
      range.start <= previousEnd || range.start <= row.firstEpisodeIndex! ||
      range.end >= row.lastEpisodeIndex!
    ) return invalid(row);
    missing += range.end - range.start + 1;
    previousEnd = range.end;
  }
  if (
    missing !== row.missingCount ||
    (row.status === 'gaps') !== (missing > 0) ||
    (row.status === 'ok') !== (ranges.length === 0)
  ) return invalid(row);
  return output(row, row.status, null, ranges);
}

export function decodeSeasonGapProjection(row: SeasonGapProjectionRow): SeasonGapShow {
  if (row.status === 'irregular' && SEASON_IRREGULAR_REASONS.has(row.reason ?? '')) {
    return seasonOutput(row, 'irregular', row.reason, []);
  }
  if (row.status !== 'ok' && row.status !== 'gaps') return invalidSeason(row);
  if (
    !Number.isSafeInteger(row.firstSeasonIndex) || !Number.isSafeInteger(row.lastSeasonIndex) ||
    !Number.isSafeInteger(row.presentCount) || !Number.isSafeInteger(row.missingCount) ||
    row.firstSeasonIndex! <= 0 || row.lastSeasonIndex! < row.firstSeasonIndex! ||
    row.lastSeasonIndex! > 10_000 || row.presentCount! <= 0 || row.missingCount! < 0 ||
    row.lastSeasonIndex! - row.firstSeasonIndex! + 1 !== row.presentCount! + row.missingCount!
  ) return invalidSeason(row);
  const ranges = decodeRanges(
    row.missingRangesJson,
    row.firstSeasonIndex!,
    row.lastSeasonIndex!,
  );
  if (
    !ranges || rangeWidth(ranges) !== row.missingCount ||
    (row.status === 'gaps') !== (ranges.length > 0) ||
    (row.status === 'ok') !== (ranges.length === 0)
  ) return invalidSeason(row);
  return seasonOutput(row, row.status, null, ranges);
}

function invalid(row: EpisodeGapProjectionRow): EpisodeGapSeason {
  console.warn(`Invalid episode-gap projection for season ${row.seasonRatingKey}`);
  return output(row, 'irregular', 'invalid_projection', []);
}

function invalidSeason(row: SeasonGapProjectionRow): SeasonGapShow {
  console.warn(`Invalid season-gap projection for show ${row.showRatingKey}`);
  return seasonOutput(row, 'irregular', 'invalid_projection', []);
}

function decodeRanges(json: string | null, first: number, last: number): EpisodeGapRange[] | null {
  try {
    const parsed: unknown = JSON.parse(json ?? '');
    if (!Array.isArray(parsed) || parsed.length > 256) return null;
    let previousEnd = 0;
    return parsed.map((range) => {
      if (
        typeof range !== 'object' || range === null ||
        !Number.isSafeInteger((range as EpisodeGapRange).start) ||
        !Number.isSafeInteger((range as EpisodeGapRange).end) ||
        (range as EpisodeGapRange).start <= first ||
        (range as EpisodeGapRange).end >= last ||
        (range as EpisodeGapRange).end < (range as EpisodeGapRange).start ||
        (range as EpisodeGapRange).start <= previousEnd
      ) throw new Error('invalid range');
      previousEnd = (range as EpisodeGapRange).end;
      return { start: (range as EpisodeGapRange).start, end: (range as EpisodeGapRange).end };
    });
  } catch {
    return null;
  }
}

function rangeWidth(ranges: EpisodeGapRange[]): number {
  return ranges.reduce((total, range) => total + range.end - range.start + 1, 0);
}

function output(
  row: EpisodeGapProjectionRow,
  status: EpisodeGapSeason['status'],
  reason: string | null,
  missingRanges: EpisodeGapRange[],
): EpisodeGapSeason {
  return {
    libraryKey: row.libraryKey,
    libraryTitle: row.libraryTitle,
    showRatingKey: row.showRatingKey,
    showTitle: row.showTitle,
    showThumb: row.showThumb,
    seasonRatingKey: row.seasonRatingKey,
    seasonIndex: row.seasonIndex,
    seasonTitle: row.seasonTitle,
    firstEpisodeIndex: status === 'irregular' ? null : row.firstEpisodeIndex,
    lastEpisodeIndex: status === 'irregular' ? null : row.lastEpisodeIndex,
    presentCount: status === 'irregular' ? 0 : row.presentCount ?? 0,
    missingCount: status === 'irregular' ? 0 : row.missingCount ?? 0,
    missingRanges,
    status,
    reason,
    episodeAuditSyncedAt: row.episodeAuditSyncedAt,
  };
}

function seasonOutput(
  row: SeasonGapProjectionRow,
  status: SeasonGapShow['status'],
  reason: string | null,
  missingRanges: EpisodeGapRange[],
): SeasonGapShow {
  return {
    libraryKey: row.libraryKey,
    libraryTitle: row.libraryTitle,
    showRatingKey: row.showRatingKey,
    showTitle: row.showTitle,
    showThumb: row.showThumb,
    firstSeasonIndex: status === 'irregular' ? null : row.firstSeasonIndex,
    lastSeasonIndex: status === 'irregular' ? null : row.lastSeasonIndex,
    presentCount: status === 'irregular' ? 0 : row.presentCount ?? 0,
    missingCount: status === 'irregular' ? 0 : row.missingCount ?? 0,
    missingRanges,
    status,
    reason,
    episodeAuditSyncedAt: row.episodeAuditSyncedAt,
  };
}
