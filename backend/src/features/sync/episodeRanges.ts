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

    let presentCount = 0;
    const gaps: EpisodeRange[] = [];
    let gapCount = 0;
    for (let i = 0; i < this.ranges.length; i++) {
      const range = this.ranges[i]!;
      const width = range.end - range.start + 1;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(presentCount + width)) {
        return emptyAudit('irregular', 'range_limit_exceeded');
      }
      presentCount += width;
      const next = this.ranges[i + 1];
      if (!next) continue;
      const missing = next.start - range.end - 1;
      if (!Number.isSafeInteger(missing) || !Number.isSafeInteger(gapCount + missing)) {
        return emptyAudit('irregular', 'range_limit_exceeded');
      }
      gapCount += missing;
      gaps.push({ start: range.end + 1, end: next.start - 1 });
      if (gaps.length > MAX_MISSING_RANGES) {
        return emptyAudit('irregular', 'range_limit_exceeded');
      }
    }
    return {
      status: gapCount > 0 ? 'gaps' : 'ok',
      reason: null,
      firstIndex: this.ranges[0]!.start,
      lastIndex: this.ranges.at(-1)!.end,
      presentCount,
      gapCount,
      gapRanges: gaps,
    };
  }
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
