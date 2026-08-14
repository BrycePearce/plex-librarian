import type { MediaVersion } from './types/media/versions.ts';

export const DUPLICATE_DIFFERENCE_CODES = [
  'resolution',
  'runtime',
  'video-encoding',
  'dynamic-range',
  'bitrate',
  'frame-rate',
  'interlacing',
  'container',
  'audio-tracks',
  'subtitle-tracks',
] as const;

export type DuplicateDifferenceCode = typeof DUPLICATE_DIFFERENCE_CODES[number];

export const DUPLICATE_DIFFERENCE_LABELS: Record<DuplicateDifferenceCode, string> = {
  resolution: 'Resolution differs',
  runtime: 'Runtime differs',
  'video-encoding': 'Video encoding differs',
  'dynamic-range': 'HDR format differs',
  bitrate: 'Bitrate differs',
  'frame-rate': 'Frame rate differs',
  interlacing: 'Interlacing differs',
  container: 'Container differs',
  'audio-tracks': 'Audio tracks differ',
  'subtitle-tracks': 'Subtitle tracks differ',
};

export type DuplicateComparison = {
  kind: 'same-profile' | 'different' | 'unknown';
  label: string;
  differenceCodes: DuplicateDifferenceCode[];
  reasons: string[];
};

export interface DuplicateSeasonDifferenceCount {
  code: DuplicateDifferenceCode;
  episodeCount: number;
}

export interface DuplicateSeasonComparisonSummary {
  episodeCount: number;
  differentEpisodeCount: number;
  sameProfileEpisodeCount: number;
  needsReviewEpisodeCount: number;
  differences: DuplicateSeasonDifferenceCount[];
}

// Mirrors DuplicateComparison["kind"] exactly (plus "all") rather than inventing a finer
// split — the per-reason detail (which attribute differs) is still available in
// `reasons` for display, but is not itself a filterable bucket. Buckets are the three
// decisions a user actually needs to make: safe-looking duplicate, needs judgment, or
// not enough data to tell.
export type DuplicateComparisonFilter = 'all' | DuplicateComparison['kind'];

function normalized(value: string | null): string | null {
  const result = value?.trim().toLowerCase();
  return result ? result : null;
}

function knownValuesDiffer<T>(values: Array<T | null>): boolean {
  const known = values.filter((value): value is T => value != null);
  return known.length >= 2 && new Set(known).size > 1;
}

function numericRangeDiffers(
  values: Array<number | null>,
  ratio = 1.15,
): boolean {
  const known = values.filter((value): value is number => value != null && value > 0);
  return known.length >= 2 && Math.max(...known) / Math.min(...known) >= ratio;
}

function streamSignature(
  version: MediaVersion,
  type: 'audio' | 'subtitle',
): string | null {
  if (!version.streamDetailsAvailable) return null;
  const streams = type === 'audio' ? version.audioStreams : version.subtitleStreams;
  return streams.map((stream) =>
    [
      normalized(stream.codec),
      normalized(stream.language),
      stream.channels,
      normalized(stream.channelLayout),
      normalized(stream.title),
      stream.forced,
      stream.default,
    ].join('|')
  ).sort().join(';');
}

export function compareDuplicateVersions(
  versions: readonly MediaVersion[],
): DuplicateComparison {
  if (versions.length < 2) {
    return {
      kind: 'unknown',
      label: 'Needs review',
      differenceCodes: [],
      reasons: ['Only one version is available'],
    };
  }

  const differenceCodes: DuplicateDifferenceCode[] = [];
  const dimensions = versions.map((version) =>
    version.width != null && version.height != null
      ? `${version.width}x${version.height}`
      : normalized(version.videoResolution)
  );
  if (knownValuesDiffer(dimensions)) differenceCodes.push('resolution');
  if (
    knownValuesDiffer(
      versions.map((version) => normalized(version.videoDynamicRange)),
    )
  ) {
    differenceCodes.push('dynamic-range');
  }
  if (
    knownValuesDiffer(
      versions.map((version) => normalized(version.videoCodec)),
    ) ||
    knownValuesDiffer(
      versions.map((version) => normalized(version.videoProfile)),
    ) ||
    knownValuesDiffer(versions.map((version) => version.videoBitDepth))
  ) {
    differenceCodes.push('video-encoding');
  }
  if (numericRangeDiffers(versions.map((version) => version.bitrate))) {
    differenceCodes.push('bitrate');
  }
  if (
    knownValuesDiffer(versions.map((version) => normalized(version.container)))
  ) {
    differenceCodes.push('container');
  }
  if (
    knownValuesDiffer(
      versions.map((version) => normalized(version.videoFrameRate)),
    )
  ) {
    differenceCodes.push('frame-rate');
  }
  if (
    knownValuesDiffer(
      versions.map((version) => normalized(version.videoScanType)),
    )
  ) {
    differenceCodes.push('interlacing');
  }

  const durations = versions.map((version) => version.duration).filter(
    (duration): duration is number => duration != null,
  );
  if (
    durations.length >= 2 &&
    Math.max(...durations) - Math.min(...durations) > 2_000
  ) {
    differenceCodes.push('runtime');
  }

  const detailedAudioSignatures = versions.map((version) => streamSignature(version, 'audio'));
  if (
    knownValuesDiffer(detailedAudioSignatures) ||
    knownValuesDiffer(
      versions.map((version) => normalized(version.audioCodec)),
    ) ||
    knownValuesDiffer(versions.map((version) => version.audioChannels)) ||
    knownValuesDiffer(
      versions.map((version) => normalized(version.audioProfile)),
    )
  ) {
    differenceCodes.push('audio-tracks');
  }

  const subtitleSignatures = versions.map((version) => streamSignature(version, 'subtitle'));
  if (knownValuesDiffer(subtitleSignatures)) {
    differenceCodes.push('subtitle-tracks');
  }

  if (differenceCodes.length > 0) {
    return {
      kind: 'different',
      label: 'Meaningful differences',
      differenceCodes,
      reasons: differenceCodes.map((code) => DUPLICATE_DIFFERENCE_LABELS[code]),
    };
  }

  const hasCompleteDuration = versions.every((version) => version.duration != null);
  const hasCompleteDimensions = dimensions.every((value) => value != null);
  const hasCompleteVideo = versions.every((version) => normalized(version.videoCodec) != null);
  const hasCompleteBitrate = versions.every((version) => version.bitrate != null);
  const hasCompleteContainer = versions.every((version) => normalized(version.container) != null);
  const hasCompleteDetailedAudio = detailedAudioSignatures.every((value) =>
    value != null && value !== ''
  );
  const hasCompleteBasicAudio = versions.every((version) =>
    normalized(version.audioCodec) != null && version.audioChannels != null
  );
  const hasCompleteAudio = hasCompleteDetailedAudio || hasCompleteBasicAudio;
  const hasConsistentDynamicRange =
    versions.every((version) => version.videoDynamicRange == null) ||
    versions.every((version) => version.videoDynamicRange != null);
  const hasConsistentFrameRate = versions.every((version) => version.videoFrameRate == null) ||
    versions.every((version) => version.videoFrameRate != null);
  const hasConsistentScanType = versions.every((version) => version.videoScanType == null) ||
    versions.every((version) => version.videoScanType != null);
  if (
    hasCompleteDuration && hasCompleteDimensions && hasCompleteVideo &&
    hasCompleteAudio &&
    hasCompleteBitrate && hasCompleteContainer && hasConsistentDynamicRange &&
    hasConsistentFrameRate && hasConsistentScanType
  ) {
    return {
      kind: 'same-profile',
      label: 'Same technical profile',
      differenceCodes: [],
      reasons: [
        'Plex reports matching runtime, video, and audio characteristics',
      ],
    };
  }

  return {
    kind: 'unknown',
    label: 'Needs review',
    differenceCodes: [],
    reasons: [
      'Plex did not report enough technical metadata to compare safely',
    ],
  };
}

export function summarizeDuplicateComparisons(
  comparisons: readonly DuplicateComparison[],
): DuplicateSeasonComparisonSummary {
  const counts = new Map<DuplicateDifferenceCode, number>();
  let differentEpisodeCount = 0;
  let sameProfileEpisodeCount = 0;
  let needsReviewEpisodeCount = 0;

  for (const comparison of comparisons) {
    if (comparison.kind === 'different') differentEpisodeCount++;
    else if (comparison.kind === 'same-profile') sameProfileEpisodeCount++;
    else needsReviewEpisodeCount++;

    for (const code of new Set(comparison.differenceCodes)) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }

  return {
    episodeCount: comparisons.length,
    differentEpisodeCount,
    sameProfileEpisodeCount,
    needsReviewEpisodeCount,
    differences: DUPLICATE_DIFFERENCE_CODES.flatMap((code) => {
      const episodeCount = counts.get(code) ?? 0;
      return episodeCount > 0 ? [{ code, episodeCount }] : [];
    }),
  };
}
