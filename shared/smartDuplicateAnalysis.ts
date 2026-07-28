import { compareDuplicateVersions } from './mediaComparison.ts';
import { bestMediaVersionCandidate } from './mediaVersionRanking.ts';
import type { MediaVersion, SmartDuplicateConfidence } from './types.ts';

export interface SmartVersionRecommendation {
  confidence: SmartDuplicateConfidence;
  keepMediaId: number;
  deleteMediaIds: number[];
  reclaimableSize: number | null;
  reasons: string[];
}

function normalized(value: string | null): string | null {
  const result = value?.trim().toLowerCase();
  return result ? result : null;
}

function allEqual<T>(values: readonly T[]): boolean {
  return values.length > 0 && values.every((value) => value === values[0]);
}

function dimensions(version: MediaVersion): string | null {
  if (version.width != null && version.height != null) {
    return `${version.width}x${version.height}`;
  }
  return normalized(version.videoResolution);
}

function bitrateRatio(versions: readonly MediaVersion[]): number {
  const bitrates = versions.map((version) => version.bitrate).filter(
    (value): value is number => value != null && value > 0,
  );
  if (bitrates.length !== versions.length) return Number.POSITIVE_INFINITY;
  return Math.max(...bitrates) / Math.min(...bitrates);
}

function runtimeSpread(versions: readonly MediaVersion[]): number {
  const durations = versions.map((version) => version.duration).filter(
    (value): value is number => value != null,
  );
  if (durations.length !== versions.length) return Number.POSITIVE_INFINITY;
  return Math.max(...durations) - Math.min(...durations);
}

function hasCompleteStreamDetails(versions: readonly MediaVersion[]): boolean {
  return versions.every((version) =>
    version.streamDetailsAvailable &&
    dimensions(version) != null &&
    version.duration != null &&
    normalized(version.videoCodec) != null &&
    version.bitrate != null &&
    normalized(version.container) != null
  );
}

function exactExceptDimensionsBitrateAndContainer(versions: readonly MediaVersion[]): boolean {
  const fields: Array<Array<string | number | null>> = [
    versions.map((version) => normalized(version.videoCodec)),
    versions.map((version) => normalized(version.videoProfile)),
    versions.map((version) => version.videoBitDepth),
    versions.map((version) => normalized(version.videoDynamicRange)),
    versions.map((version) => normalized(version.videoFrameRate)),
    versions.map((version) => normalized(version.videoScanType)),
    versions.map((version) => normalized(version.audioCodec)),
    versions.map((version) => version.audioChannels),
    versions.map((version) => normalized(version.audioProfile)),
  ];
  return fields.every((values) => allEqual(values));
}

function subtitleLanguageKey(
  stream: MediaVersion['subtitleStreams'][number],
): string | null {
  const language = normalized(stream.language);
  if (!language) return null;
  return `${language}:${stream.forced ? 'forced' : 'regular'}`;
}

function hasSharedSubtitleCoverage(versions: readonly MediaVersion[]): boolean {
  const coverage = versions.map((version) =>
    new Set(
      version.subtitleStreams.map(subtitleLanguageKey).filter(
        (value): value is string => value !== null,
      ),
    )
  );
  if (coverage.some((languages) => languages.size === 0)) return false;
  return [...coverage[0]!].some((language) =>
    coverage.slice(1).every((languages) => languages.has(language))
  );
}

function sameDimensions(versions: readonly MediaVersion[]): boolean {
  return allEqual(versions.map(dimensions));
}

function preferredResolutionDoesNotLoseBitrate(versions: readonly MediaVersion[]): boolean {
  const keepMediaId = bestMediaVersionCandidate(
    versions,
    versions.map((version) => version.mediaId),
  );
  const retained = versions.find((version) => version.mediaId === keepMediaId);
  if (!retained || retained.bitrate == null) return false;
  const retainedBitrate = retained.bitrate;
  return versions.every((version) =>
    version.bitrate != null &&
    (version.mediaId === retained.mediaId || retainedBitrate >= version.bitrate)
  );
}

function recommendation(
  versions: readonly MediaVersion[],
  confidence: SmartDuplicateConfidence,
  reasons: string[],
): SmartVersionRecommendation | null {
  const mediaIds = versions.map((version) => version.mediaId);
  const keepMediaId = bestMediaVersionCandidate(versions, mediaIds);
  if (keepMediaId === null) return null;
  const deleted = versions.filter((version) => version.mediaId !== keepMediaId);
  if (deleted.length === 0) return null;
  const hasKnownSize = deleted.every((version) => version.fileSize != null);
  return {
    confidence,
    keepMediaId,
    deleteMediaIds: deleted.map((version) => version.mediaId).sort((a, b) => a - b),
    reclaimableSize: hasKnownSize
      ? deleted.reduce((total, version) => total + version.fileSize!, 0)
      : null,
    reasons,
  };
}

// Smart cleanup is intentionally stricter than the duplicates-page presentation
// buckets. Presentation can call two files "same profile" with partial optional
// metadata; unattended selection requires complete stream detail and agreement on
// core content-bearing dimensions, with bounded quality and subtitle variation.
export function analyzeSmartDuplicateVersions(
  versions: readonly MediaVersion[],
): SmartVersionRecommendation | null {
  if (versions.length < 2 || !hasCompleteStreamDetails(versions)) return null;

  const comparison = compareDuplicateVersions(versions);
  const sameContainer = allEqual(
    versions.map((version) => normalized(version.container)),
  );
  const matchingContentProfile = exactExceptDimensionsBitrateAndContainer(versions);
  const matchingDimensions = sameDimensions(versions);
  const exactTechnicalProfile = matchingContentProfile && matchingDimensions && sameContainer;

  if (
    comparison.kind === 'same-profile' &&
    exactTechnicalProfile &&
    runtimeSpread(versions) <= 1_000 &&
    bitrateRatio(versions) <= 1.05
  ) {
    return recommendation(versions, 'obvious', [
      'Matching runtime, video, HDR, audio, and subtitle streams',
      'Bitrate differs by no more than 5%',
    ]);
  }

  const subtitleCoverageOverlaps = hasSharedSubtitleCoverage(versions);
  const allowedNearDifferences = new Set([
    'Resolution differs',
    'Bitrate differs',
    'Container differs',
    ...(subtitleCoverageOverlaps ? ['Subtitle tracks differ'] : []),
  ]);
  const onlyNearDifferences = comparison.kind === 'same-profile' ||
    (comparison.kind === 'different' &&
      comparison.reasons.every((reason) => allowedNearDifferences.has(reason)));
  const resolutionOnlyQualityDifference = !matchingDimensions;
  if (
    onlyNearDifferences &&
    matchingContentProfile &&
    sameContainer &&
    runtimeSpread(versions) <= 2_000 &&
    (resolutionOnlyQualityDifference
      ? preferredResolutionDoesNotLoseBitrate(versions)
      : bitrateRatio(versions) <= 1.15)
  ) {
    const nearDifferenceReason = resolutionOnlyQualityDifference
      ? 'Resolution differs; the higher-quality copy is retained by default'
      : comparison.reasons.includes('Bitrate differs')
      ? 'Bitrate differs by no more than 15%'
      : 'Some subtitle tracks differ; shared language coverage remains';
    return recommendation(versions, 'near-identical', [
      subtitleCoverageOverlaps && comparison.reasons.includes('Subtitle tracks differ')
        ? 'Matching runtime, video, HDR, and audio with overlapping subtitle coverage'
        : 'Matching runtime, video, HDR, audio, and subtitle streams',
      nearDifferenceReason,
    ]);
  }

  if (
    onlyNearDifferences &&
    matchingContentProfile &&
    runtimeSpread(versions) <= 2_000
  ) {
    return recommendation(versions, 'review', [
      subtitleCoverageOverlaps && comparison.reasons.includes('Subtitle tracks differ')
        ? 'Matching runtime, video, HDR, and audio with overlapping subtitle coverage'
        : 'Matching runtime, video, HDR, audio, and subtitle streams',
      sameContainer ? 'Bitrate difference needs review' : 'Container differs',
    ]);
  }

  return null;
}
