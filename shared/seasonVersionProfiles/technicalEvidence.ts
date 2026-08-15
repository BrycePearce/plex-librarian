import type { MediaStreamSummary, MediaVersion } from '../types.ts';

export type SeasonEpisodeLiveEvidence =
  | { status: 'complete'; versions: ReadonlyMap<number, { filePath?: string | null }> }
  | {
    status: 'mismatch';
    versions: ReadonlyMap<number, { filePath?: string | null }>;
    missingExpectedMediaIds: readonly number[];
    unexpectedLiveMediaIds: readonly number[];
  }
  | { status: 'failed'; versions: ReadonlyMap<number, never> };

export function normalized(value: string | null): string | null {
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

export function sortedLaneStreamKeys(
  streams: readonly MediaStreamSummary[],
  audio: boolean,
): string[] {
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

/** Technical family evidence retained for compatibility and display grouping. */
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
