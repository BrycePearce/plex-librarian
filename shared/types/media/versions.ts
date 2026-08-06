export interface MediaStreamSummary {
  codec: string | null;
  language: string | null;
  channels: number | null;
  channelLayout: string | null;
  title: string | null;
  forced: boolean;
  default: boolean;
}

export interface MediaVersion {
  mediaId: number;
  videoResolution: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  bitrate: number | null;
  videoCodec: string | null;
  videoProfile: string | null;
  videoBitDepth: number | null;
  videoDynamicRange: string | null;
  videoFrameRate: string | null;
  videoScanType: string | null;
  container: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  audioProfile: string | null;
  audioStreams: MediaStreamSummary[];
  subtitleStreams: MediaStreamSummary[];
  streamDetailsAvailable: boolean;
  fileSize: number | null;
}

export interface DeleteMediaVersionResponse {
  fileSizeFreed: number;
  removedByApp: boolean;
}

// Returned by the on-demand technical-detail refresh used by duplicate review.
export interface MediaVersionsRefreshResponse {
  versions: MediaVersion[];
}
