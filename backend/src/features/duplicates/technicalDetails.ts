import type { PlexMediaTechnicalDetails } from '../../integrations/plex/types.ts';

// Writes live per-Media detail back onto the same fields sync populates. File size,
// container, and the other top-level Media fields are deliberately left alone.
// `updatedAt` is also the full-sync generation marker used to prune disappeared
// versions, so enrichment must never advance it.
export function technicalDetailUpdate(detail: PlexMediaTechnicalDetails) {
  return {
    width: detail.width,
    height: detail.height,
    duration: detail.duration,
    videoProfile: detail.videoProfile,
    videoBitDepth: detail.videoBitDepth,
    videoDynamicRange: detail.videoDynamicRange,
    videoFrameRate: detail.videoFrameRate,
    videoScanType: detail.videoScanType,
    audioCodec: detail.audioCodec,
    audioChannels: detail.audioChannels,
    audioProfile: detail.audioProfile,
    audioStreamsJson: JSON.stringify(detail.audioStreams),
    subtitleStreamsJson: JSON.stringify(detail.subtitleStreams),
    streamDetailsAvailable: detail.streamDetailsAvailable,
  };
}
