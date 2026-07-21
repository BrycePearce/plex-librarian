import type { MediaVersion } from './types.ts';

export type DuplicateComparison = {
  kind: 'same-profile' | 'different' | 'unknown';
  label: string;
  reasons: string[];
};

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
      reasons: ['Only one version is available'],
    };
  }

  const differences: string[] = [];
  const dimensions = versions.map((version) =>
    version.width != null && version.height != null
      ? `${version.width}x${version.height}`
      : normalized(version.videoResolution)
  );
  if (knownValuesDiffer(dimensions)) differences.push('Resolution differs');
  if (
    knownValuesDiffer(
      versions.map((version) => normalized(version.videoDynamicRange)),
    )
  ) {
    differences.push('HDR format differs');
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
    differences.push('Video encoding differs');
  }
  if (numericRangeDiffers(versions.map((version) => version.bitrate))) {
    differences.push('Bitrate differs');
  }
  if (
    knownValuesDiffer(versions.map((version) => normalized(version.container)))
  ) {
    differences.push('Container differs');
  }
  if (
    knownValuesDiffer(
      versions.map((version) => normalized(version.videoFrameRate)),
    )
  ) {
    differences.push('Frame rate differs');
  }
  if (
    knownValuesDiffer(
      versions.map((version) => normalized(version.videoScanType)),
    )
  ) {
    differences.push('Interlacing differs');
  }

  const durations = versions.map((version) => version.duration).filter(
    (duration): duration is number => duration != null,
  );
  if (
    durations.length >= 2 &&
    Math.max(...durations) - Math.min(...durations) > 2_000
  ) {
    differences.push('Runtime differs');
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
    differences.push('Audio tracks differ');
  }

  const subtitleSignatures = versions.map((version) => streamSignature(version, 'subtitle'));
  if (knownValuesDiffer(subtitleSignatures)) {
    differences.push('Subtitle tracks differ');
  }

  if (differences.length > 0) {
    return {
      kind: 'different',
      label: 'Meaningful differences',
      reasons: differences,
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
      reasons: [
        'Plex reports matching runtime, video, and audio characteristics',
      ],
    };
  }

  return {
    kind: 'unknown',
    label: 'Needs review',
    reasons: [
      'Plex did not report enough technical metadata to compare safely',
    ],
  };
}
