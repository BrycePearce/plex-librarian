export const MAX_EPISODE_INDEX = 10_000;
export const MAX_SEASON_INDEX = 10_000;
export const MAX_PRESENT_RANGES = 256;
export const MAX_MISSING_RANGES = 256;

export type EpisodeAuditReason =
  | 'invalid_episode_index'
  | 'episode_index_too_large'
  | 'invalid_season_index'
  | 'season_index_too_large'
  | 'range_limit_exceeded'
  | 'conflicting_season_identity'
  | 'episode_zero_only'
  | 'season_zero';

export interface EpisodeRange {
  start: number;
  end: number;
}

export interface EpisodeRangeAudit {
  status: 'ok' | 'gaps' | 'irregular' | 'excluded';
  reason: EpisodeAuditReason | null;
  firstIndex: number | null;
  lastIndex: number | null;
  presentCount: number | null;
  gapCount: number | null;
  gapRanges: EpisodeRange[] | null;
}

export type SeasonAuditReason =
  | 'invalid_season_index'
  | 'season_index_too_large'
  | 'range_limit_exceeded'
  | 'conflicting_season_identity'
  | 'no_numbered_seasons';

export interface SeasonRangeAudit {
  status: 'ok' | 'gaps' | 'irregular' | 'excluded';
  reason: SeasonAuditReason | null;
  firstIndex: number | null;
  lastIndex: number | null;
  presentCount: number | null;
  gapCount: number | null;
  gapRanges: EpisodeRange[] | null;
}

export class EpisodeRangeSet {
  private ranges: EpisodeRange[] = [];
  private failure: EpisodeAuditReason | null = null;
  private sawEpisodeZero = false;

  invalidate(reason: EpisodeAuditReason): void {
    this.failure ??= reason;
    this.ranges = [];
  }

  insert(rawIndex: number | null): void {
    if (this.failure) return;
    // Plex uses index 0 for specials and pre-season extras. These occasionally remain
    // attached to a numbered season (S16E00, for example), so they are outside the
    // completeness range rather than evidence that the season's numbering is invalid.
    if (rawIndex === 0) {
      this.sawEpisodeZero = true;
      return;
    }
    if (!Number.isSafeInteger(rawIndex) || (rawIndex ?? 0) < 0) {
      this.invalidate('invalid_episode_index');
      return;
    }
    const index = rawIndex as number;
    if (index > MAX_EPISODE_INDEX) {
      this.invalidate('episode_index_too_large');
      return;
    }

    let position = 0;
    while (position < this.ranges.length && this.ranges[position]!.end < index - 1) position++;
    const current = this.ranges[position];
    if (!current) this.ranges.push({ start: index, end: index });
    else if (current.start <= index && current.end >= index) return;
    else if (current.start === index + 1) current.start = index;
    else if (current.end === index - 1) current.end = index;
    else this.ranges.splice(position, 0, { start: index, end: index });

    const changed = this.ranges[position]!;
    const next = this.ranges[position + 1];
    if (next && changed.end + 1 >= next.start) {
      changed.end = Math.max(changed.end, next.end);
      this.ranges.splice(position + 1, 1);
    }
    if (this.ranges.length > MAX_PRESENT_RANGES) this.invalidate('range_limit_exceeded');
  }

  finish(seasonIndex: number): EpisodeRangeAudit {
    if (seasonIndex === 0) return emptyAudit('excluded', 'season_zero');
    if (!Number.isSafeInteger(seasonIndex) || seasonIndex < 0) {
      return emptyAudit('irregular', 'invalid_season_index');
    }
    if (seasonIndex > MAX_SEASON_INDEX) {
      return emptyAudit('irregular', 'season_index_too_large');
    }
    if (this.failure) return emptyAudit('irregular', this.failure);
    if (this.ranges.length === 0 && this.sawEpisodeZero) {
      return emptyAudit('excluded', 'episode_zero_only');
    }
    if (this.ranges.length === 0) return emptyAudit('irregular', 'invalid_episode_index');

    const result = auditInternalRanges(this.ranges);
    if (!result) return emptyAudit('irregular', 'range_limit_exceeded');
    return {
      status: result.gapCount > 0 ? 'gaps' : 'ok',
      reason: null,
      firstIndex: this.ranges[0]!.start,
      lastIndex: this.ranges.at(-1)!.end,
      presentCount: result.presentCount,
      gapCount: result.gapCount,
      gapRanges: result.gapRanges,
    };
  }
}

export function auditSeasonIndexes(
  rawIndexes: Iterable<number>,
  conflictingIdentity = false,
): SeasonRangeAudit {
  if (conflictingIdentity) return emptySeasonAudit('irregular', 'conflicting_season_identity');
  const indexes = new Set<number>();
  for (const rawIndex of rawIndexes) {
    if (rawIndex === 0) continue;
    if (!Number.isSafeInteger(rawIndex) || rawIndex < 0) {
      return emptySeasonAudit('irregular', 'invalid_season_index');
    }
    if (rawIndex > MAX_SEASON_INDEX) {
      return emptySeasonAudit('irregular', 'season_index_too_large');
    }
    indexes.add(rawIndex);
  }
  if (indexes.size === 0) return emptySeasonAudit('excluded', 'no_numbered_seasons');
  const ranges: EpisodeRange[] = [];
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last.end + 1 === index) last.end = index;
    else ranges.push({ start: index, end: index });
    if (ranges.length > MAX_PRESENT_RANGES) {
      return emptySeasonAudit('irregular', 'range_limit_exceeded');
    }
  }
  const result = auditInternalRanges(ranges);
  if (!result) return emptySeasonAudit('irregular', 'range_limit_exceeded');
  return {
    status: result.gapCount > 0 ? 'gaps' : 'ok',
    reason: null,
    firstIndex: ranges[0]!.start,
    lastIndex: ranges.at(-1)!.end,
    presentCount: result.presentCount,
    gapCount: result.gapCount,
    gapRanges: result.gapRanges,
  };
}

function auditInternalRanges(ranges: EpisodeRange[]): {
  presentCount: number;
  gapCount: number;
  gapRanges: EpisodeRange[];
} | null {
  let presentCount = 0;
  const gapRanges: EpisodeRange[] = [];
  let gapCount = 0;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]!;
    const width = range.end - range.start + 1;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(presentCount + width)) return null;
    presentCount += width;
    const next = ranges[i + 1];
    if (!next) continue;
    const missing = next.start - range.end - 1;
    if (!Number.isSafeInteger(missing) || !Number.isSafeInteger(gapCount + missing)) return null;
    gapCount += missing;
    gapRanges.push({ start: range.end + 1, end: next.start - 1 });
    if (gapRanges.length > MAX_MISSING_RANGES) return null;
  }
  return { presentCount, gapCount, gapRanges };
}

function emptyAudit(
  status: 'irregular' | 'excluded',
  reason: EpisodeAuditReason,
): EpisodeRangeAudit {
  return {
    status,
    reason,
    firstIndex: null,
    lastIndex: null,
    presentCount: null,
    gapCount: null,
    gapRanges: null,
  };
}

function emptySeasonAudit(
  status: 'irregular' | 'excluded',
  reason: SeasonAuditReason,
): SeasonRangeAudit {
  return {
    status,
    reason,
    firstIndex: null,
    lastIndex: null,
    presentCount: null,
    gapCount: null,
    gapRanges: null,
  };
}
