import type {
  DuplicateEpisodeGroup,
  MediaStreamSummary,
  MediaVersion,
  SeasonVersionProfile,
} from './types.ts';

function normalized(value: string | null): string | null {
  const result = value?.trim().toLowerCase();
  return result || null;
}

function streamKey(stream: MediaStreamSummary, audio: boolean): string {
  return JSON.stringify([
    normalized(stream.language),
    normalized(stream.codec),
    audio ? stream.channels : null,
    audio ? normalized(stream.channelLayout) : null,
    audio ? null : stream.forced,
  ]);
}

function sortedStreamKeys(streams: readonly MediaStreamSummary[], audio: boolean): string[] {
  return streams.map((stream) => streamKey(stream, audio)).sort();
}

function laneStreamKey(stream: MediaStreamSummary, audio: boolean): string {
  return JSON.stringify([
    normalized(stream.language),
    normalized(stream.codec),
    audio ? stream.channels : null,
    audio ? null : stream.forced,
  ]);
}

function sortedLaneStreamKeys(streams: readonly MediaStreamSummary[], audio: boolean): string[] {
  return streams.map((stream) => laneStreamKey(stream, audio)).sort();
}

export function seasonVersionFingerprint(version: MediaVersion): string | null {
  if (!version.streamDetailsAvailable) return null;
  const dimensions = version.width != null && version.height != null
    ? `${version.width}x${version.height}`
    : normalized(version.videoResolution);
  if (!dimensions || !normalized(version.videoCodec) || !normalized(version.container)) return null;
  return JSON.stringify({
    dimensions,
    videoCodec: normalized(version.videoCodec),
    videoProfile: normalized(version.videoProfile),
    videoBitDepth: version.videoBitDepth,
    dynamicRange: normalized(version.videoDynamicRange),
    frameRate: normalized(version.videoFrameRate),
    scanType: normalized(version.videoScanType),
    container: normalized(version.container),
    audio: sortedStreamKeys(version.audioStreams, true),
    subtitles: sortedStreamKeys(version.subtitleStreams, false),
  });
}

/** Technical family evidence used by the one-to-one season lane matcher. */
export function seasonVersionLaneKey(version: MediaVersion): string | null {
  if (!version.streamDetailsAvailable) return null;
  const dimensions = version.width != null && version.height != null
    ? `${version.width}x${version.height}`
    : normalized(version.videoResolution);
  if (!dimensions || !normalized(version.videoCodec) || !normalized(version.container)) return null;
  return JSON.stringify({
    dimensions,
    videoCodec: normalized(version.videoCodec),
    videoBitDepth: version.videoBitDepth,
    dynamicRange: normalized(version.videoDynamicRange),
    scanType: normalized(version.videoScanType),
    container: normalized(version.container),
    audio: sortedLaneStreamKeys(version.audioStreams, true),
    subtitles: sortedLaneStreamKeys(version.subtitleStreams, false),
  });
}

function profileId(evidence: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < evidence.length; index++) {
    const code = evidence.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `profile-${(left >>> 0).toString(36)}-${(right >>> 0).toString(36)}`;
}

function display(value: string | null): string {
  return value?.trim() || 'Unknown';
}

function streamLabel(stream: MediaStreamSummary, audio: boolean): string {
  const parts = [display(stream.language)];
  if (stream.codec) parts.push(stream.codec.toUpperCase());
  if (audio && stream.channels != null) parts.push(`${stream.channels}ch`);
  if (!audio && stream.forced) parts.push('forced');
  return parts.join(' · ');
}

function sumKnown(values: Array<number | null>): number | null {
  return values.every((value) => value !== null)
    ? values.reduce((total, value) => total + (value ?? 0), 0)
    : null;
}

function bitrateSummary(values: Array<number | null>): string | null {
  if (values.some((value) => value === null)) return null;
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  const minimum = Math.min(...known) / 1_000;
  const maximum = Math.max(...known) / 1_000;
  const formattedMinimum = minimum.toFixed(1);
  const formattedMaximum = maximum.toFixed(1);
  return minimum === maximum
    ? `${formattedMinimum} Mbps`
    : `${formattedMinimum}–${formattedMaximum} Mbps`;
}

export interface SeasonVersionProfileAnalysis {
  profiles: SeasonVersionProfile[];
  recommendedProfileId: string | null;
  uncertainEpisodeRatingKeys: string[];
}

interface VersionOccurrence {
  episode: DuplicateEpisodeGroup;
  version: MediaVersion;
  filePath: string | null;
  fingerprint: string;
  laneKey: string | null;
}

function comparablePathTokens(path: string | null | undefined): Set<string> {
  if (!path) return new Set();
  const normalizedPath = path.trim().toLowerCase().replaceAll('\\', '/');
  if (!normalizedPath) return new Set();
  return new Set(
    normalizedPath.split('/').slice(-3).join(' ')
      .replace(/\.[a-z0-9]{1,8}$/i, '')
      .replace(/s\d{1,3}e\d{1,4}|\d{1,3}x\d{1,4}/gi, ' ')
      .split(/[^a-z0-9]+/)
      .filter((token) =>
        token.length > 1 && !/^\d+$/.test(token) &&
        !['season', 'episode', 'episodes'].includes(token)
      ),
  );
}

export function seasonVersionSourceHint(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.trim().replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  parts.pop();
  if (/^(?:season\s*\d+|specials)$/i.test(parts.at(-1) ?? '')) parts.pop();
  return parts.at(-1) ?? null;
}

function setSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function relativeSimilarity(left: number | null, right: number | null): number {
  if (left === null || right === null || left <= 0 || right <= 0) return 0;
  return Math.max(0, 1 - Math.abs(Math.log(left / right)) / Math.log(4));
}

function same(left: string | null, right: string | null): boolean {
  const a = normalized(left);
  const b = normalized(right);
  return a !== null && a === b;
}

function occurrenceSimilarity(left: VersionOccurrence, right: VersionOccurrence): number {
  const a = left.version;
  const b = right.version;
  let score = 0;
  if (left.laneKey && left.laneKey === right.laneKey) score += 800;
  if (left.fingerprint === right.fingerprint) score += 400;
  const leftDimensions = a.width && a.height ? `${a.width}x${a.height}` : a.videoResolution;
  const rightDimensions = b.width && b.height ? `${b.width}x${b.height}` : b.videoResolution;
  score += same(leftDimensions, rightDimensions) ? 180 : -180;
  score += same(a.videoCodec, b.videoCodec) ? 120 : -120;
  score += a.videoBitDepth !== null && a.videoBitDepth === b.videoBitDepth ? 50 : 0;
  score += same(a.videoDynamicRange, b.videoDynamicRange)
    ? 70
    : a.videoDynamicRange || b.videoDynamicRange
    ? -60
    : 0;
  score += same(a.videoScanType, b.videoScanType) ? 20 : 0;
  score += same(a.container, b.container) ? 30 : -20;
  score += JSON.stringify(sortedLaneStreamKeys(a.audioStreams, true)) ===
      JSON.stringify(sortedLaneStreamKeys(b.audioStreams, true))
    ? 160
    : -80;
  score += JSON.stringify(sortedLaneStreamKeys(a.subtitleStreams, false)) ===
      JSON.stringify(sortedLaneStreamKeys(b.subtitleStreams, false))
    ? 80
    : -30;
  score += relativeSimilarity(a.bitrate, b.bitrate) * 100;
  score += relativeSimilarity(a.fileSize, b.fileSize) * 50;
  score += relativeSimilarity(a.duration, b.duration) * 30;
  score += setSimilarity(
    comparablePathTokens(left.filePath),
    comparablePathTokens(right.filePath),
  ) * 120;
  return score;
}

function occurrenceSortKey(occurrence: VersionOccurrence): string {
  const version = occurrence.version;
  return JSON.stringify([
    occurrence.laneKey,
    [...comparablePathTokens(occurrence.filePath)].sort(),
    version.bitrate,
    version.fileSize,
    version.mediaId,
  ]);
}

/** Exact maximum-weight one-to-one assignment; version count is bounded to 11. */
function assignToLanes(
  occurrences: readonly VersionOccurrence[],
  lanes: readonly VersionOccurrence[][],
): number[] {
  const memo = new Map<string, { score: number; assignment: number[] }>();
  function visit(index: number, mask: number): { score: number; assignment: number[] } {
    if (index === occurrences.length) return { score: 0, assignment: [] };
    const key = `${index}:${mask}`;
    const cached = memo.get(key);
    if (cached) return cached;
    let best: { score: number; assignment: number[] } | null = null;
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
      if ((mask & (1 << laneIndex)) !== 0) continue;
      const laneScore = Math.max(
        ...lanes[laneIndex]!.map((member) => occurrenceSimilarity(occurrences[index]!, member)),
      );
      const remainder = visit(index + 1, mask | (1 << laneIndex));
      const candidate = {
        score: laneScore + remainder.score,
        assignment: [laneIndex, ...remainder.assignment],
      };
      if (
        !best || candidate.score > best.score ||
        (candidate.score === best.score &&
          candidate.assignment.join(',') < best.assignment.join(','))
      ) best = candidate;
    }
    memo.set(key, best!);
    return best!;
  }
  return visit(0, 0).assignment;
}

function representativeOf(lane: readonly VersionOccurrence[]): VersionOccurrence {
  return [...lane].sort((left, right) => {
    const leftScore = lane.reduce((total, member) => total + occurrenceSimilarity(left, member), 0);
    const rightScore = lane.reduce(
      (total, member) => total + occurrenceSimilarity(right, member),
      0,
    );
    return rightScore - leftScore ||
      occurrenceSortKey(left).localeCompare(occurrenceSortKey(right));
  })[0]!;
}

export function analyzeSeasonVersionProfiles(
  episodes: readonly DuplicateEpisodeGroup[],
  pathHints: ReadonlyMap<string, string | null> = new Map(),
): SeasonVersionProfileAnalysis {
  const uncertain = new Set<string>();
  const completeEpisodes: VersionOccurrence[][] = [];
  for (const episode of episodes) {
    const occurrences: VersionOccurrence[] = [];
    for (const version of episode.versions) {
      const fingerprint = seasonVersionFingerprint(version);
      const laneKey = seasonVersionLaneKey(version);
      const filePath = pathHints.get(`${episode.episodeRatingKey}:${version.mediaId}`) ?? null;
      const pathTokens = comparablePathTokens(filePath);
      if (!fingerprint && pathTokens.size === 0) {
        uncertain.add(episode.episodeRatingKey);
        break;
      }
      occurrences.push({
        episode,
        version,
        filePath,
        fingerprint: fingerprint ?? `path:${[...pathTokens].sort().join('|')}`,
        laneKey,
      });
    }
    if (!uncertain.has(episode.episodeRatingKey) && occurrences.length >= 2) {
      completeEpisodes.push(
        occurrences.sort((left, right) =>
          occurrenceSortKey(left).localeCompare(occurrenceSortKey(right))
        ),
      );
    }
  }

  completeEpisodes.sort((left, right) =>
    right.length - left.length ||
    left[0]!.episode.episodeIndex - right[0]!.episode.episodeIndex ||
    left[0]!.episode.episodeRatingKey.localeCompare(right[0]!.episode.episodeRatingKey)
  );
  const lanes: VersionOccurrence[][] = completeEpisodes.length === 0
    ? []
    : completeEpisodes[0]!.map((occurrence) => [occurrence]);
  for (const occurrences of completeEpisodes.slice(1)) {
    const assignment = assignToLanes(occurrences, lanes);
    occurrences.forEach((occurrence, index) => lanes[assignment[index]!]!.push(occurrence));
  }

  const profiles: SeasonVersionProfile[] = lanes.map((members) => {
    const representative = representativeOf(members).version;
    const laneBitrateSummary = bitrateSummary(members.map(({ version }) => version.bitrate));
    const videoSummary = [
      representative.height ? `${representative.height}p` : representative.videoResolution,
      representative.videoCodec?.toUpperCase(),
      representative.videoBitDepth ? `${representative.videoBitDepth}-bit` : null,
      representative.videoDynamicRange,
      representative.videoScanType,
      representative.container?.toUpperCase(),
    ].filter(Boolean).join(' · ');
    const audioSummary = representative.audioStreams.map((stream) => streamLabel(stream, true))
      .sort();
    const subtitleSummary = representative.subtitleStreams.map((stream) =>
      streamLabel(stream, false)
    ).sort();
    const labelParts = [laneBitrateSummary, videoSummary].filter(Boolean);
    const memberIdentity = members.map(({ episode, version }) =>
      `${episode.episodeRatingKey}:${version.mediaId}`
    ).sort().join('|');
    return {
      id: profileId(memberIdentity),
      label: labelParts.join(' · ') || videoSummary || 'Technical profile',
      coverageCount: members.length,
      technicalVariantCount: new Set(members.map((member) => member.fingerprint)).size,
      totalFileSize: sumKnown(members.map(({ version }) => version.fileSize)),
      bitrateSummary: laneBitrateSummary,
      videoSummary,
      audioSummary,
      subtitleSummary,
      sourceHints: [
        ...new Set(members.flatMap(({ filePath }) => {
          const hint = seasonVersionSourceHint(filePath);
          return hint ? [hint] : [];
        })),
      ].sort(),
      members: members.map(({ episode, version, filePath }) => ({
        episodeRatingKey: episode.episodeRatingKey,
        mediaId: version.mediaId,
        filePath,
      })).sort((a, b) => a.episodeRatingKey.localeCompare(b.episodeRatingKey)),
    };
  });
  profiles.sort((left, right) =>
    right.coverageCount - left.coverageCount || left.id.localeCompare(right.id)
  );
  return {
    profiles,
    recommendedProfileId: null,
    uncertainEpisodeRatingKeys: [...uncertain].sort(),
  };
}
