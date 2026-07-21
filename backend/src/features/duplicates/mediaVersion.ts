import type { MediaStreamSummary, MediaVersion } from '@plex-librarian/shared/types.ts';
import type { episodeMediaVersions, itemMediaVersions } from '../../db/schema.ts';

type MediaVersionRow =
  | typeof itemMediaVersions.$inferSelect
  | typeof episodeMediaVersions.$inferSelect;

function parseStreams(value: string | null): MediaStreamSummary[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as MediaStreamSummary[] : [];
  } catch {
    return [];
  }
}

export function mediaVersionFromRow(row: MediaVersionRow): MediaVersion {
  return {
    mediaId: row.mediaId,
    videoResolution: row.videoResolution,
    width: row.width,
    height: row.height,
    duration: row.duration,
    bitrate: row.bitrate,
    videoCodec: row.videoCodec,
    videoProfile: row.videoProfile,
    videoBitDepth: row.videoBitDepth,
    videoDynamicRange: row.videoDynamicRange,
    videoFrameRate: row.videoFrameRate,
    videoScanType: row.videoScanType,
    container: row.container,
    audioCodec: row.audioCodec,
    audioChannels: row.audioChannels,
    audioProfile: row.audioProfile,
    audioStreams: parseStreams(row.audioStreamsJson),
    subtitleStreams: parseStreams(row.subtitleStreamsJson),
    streamDetailsAvailable: row.streamDetailsAvailable,
    fileSize: row.fileSize,
  };
}
