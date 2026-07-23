export interface PlexLibrary {
  key: string;
  title: string;
  type: string;
}

export interface PlexItem {
  ratingKey: string;
  title: string;
  type: string;
  thumb: string | null;
  addedAt: number | null;
  lastViewedAt: number | null;
  viewCount: number;
  fileSize: number | null;
  duration: number | null;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
}

export interface PlexWebhookPayload {
  event: string;
  user: boolean;
  owner: boolean;
  Account: { id: number; title: string };
  Server: { title: string; uuid: string };
  Player: { local: boolean; publicAddress: string; title: string; uuid: string };
  Metadata?: {
    librarySectionType: string;
    ratingKey: string;
    type: string;
    title: string;
    grandparentRatingKey?: string; // show ratingKey when type === 'episode'
    parentIndex?: number; // season number when type === 'episode'
    viewCount?: number;
    lastViewedAt?: number;
    duration?: number; // ms — used to accumulate users.totalDuration on scrobble
  };
}

export interface PlexRawMetadata {
  ratingKey: string;
  title: string;
  type: string;
  thumb?: string;
  addedAt?: number;
  lastViewedAt?: number;
  viewCount?: number;
  duration?: number;
  year?: number;
  Guid?: Array<{ id?: string }>;
  guid?: string;
  // Episode-level parent references — only present on type=4 responses.
  parentRatingKey?: string; // season ratingKey
  parentIndex?: number; // season number
  parentTitle?: string; // season title
  grandparentRatingKey?: string; // show ratingKey
  index?: number; // episode number within season — only present on type=4 responses, like parentIndex
  librarySectionID?: number | string;
  Media?: Array<{
    id?: number;
    videoResolution?: string;
    width?: number;
    height?: number;
    duration?: number;
    bitrate?: number;
    videoCodec?: string;
    videoProfile?: string;
    videoDynamicRange?: string;
    videoFrameRate?: string;
    container?: string;
    audioCodec?: string;
    audioChannels?: number;
    audioProfile?: string;
    Part?: Array<{
      size?: number;
      file?: string;
      Stream?: Array<{
        streamType?: number;
        codec?: string;
        language?: string;
        languageCode?: string;
        channels?: number;
        channelLayout?: string;
        audioChannelLayout?: string;
        title?: string;
        displayTitle?: string;
        forced?: boolean | number;
        default?: boolean | number;
        bitDepth?: number;
        colorTrc?: string;
        DOVIPresent?: boolean | number;
        HDR10PlusMetadataPresent?: boolean | number;
        scanType?: string;
      }>;
    }>;
  }>;
}

export interface PlexMediaStreamSummary {
  codec: string | null;
  language: string | null;
  channels: number | null;
  channelLayout: string | null;
  title: string | null;
  forced: boolean;
  default: boolean;
}

export interface PlexMediaTechnicalDetails {
  width: number | null;
  height: number | null;
  duration: number | null;
  videoProfile: string | null;
  videoBitDepth: number | null;
  videoDynamicRange: string | null;
  videoFrameRate: string | null;
  videoScanType: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  audioProfile: string | null;
  audioStreams: PlexMediaStreamSummary[];
  subtitleStreams: PlexMediaStreamSummary[];
  streamDetailsAvailable: boolean;
}

export interface PlexMetadataIdentity {
  ratingKey: string;
  title: string;
  type: string;
  librarySectionId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  parentRatingKey: string | null;
  grandparentRatingKey: string | null;
  seasonIndex: number | null;
  index: number | null;
  media: Array<{
    mediaId: number;
    videoResolution: string | null;
    bitrate: number | null;
    videoCodec: string | null;
    container: string | null;
    fileSize: number | null;
  }>;
}

// Minimal episode shape used by syncShowSizes to aggregate season file sizes.
// Not exposed via API — purely internal to the sync pipeline.
export interface PlexEpisode {
  ratingKey: string;
  seasonRatingKey: string;
  showRatingKey: string;
  seasonIndex: number;
  seasonTitle: string;
  fileSize: number | null;
  duration: number | null;
  viewCount: number;
}

// Minimal track shape used by syncArtistSizes to aggregate artist file sizes.
// Not exposed via API — purely internal to the sync pipeline.
export interface PlexTrack {
  ratingKey: string;
  artistRatingKey: string;
  fileSize: number | null;
}

// One row per Plex `Media` entry on a movie — the individual file versions Plex groups
// under one ratingKey (e.g. a 1080p rip and a 4K remux of the same movie). Used to
// populate itemMediaVersions so duplicate/multi-version groups can be surfaced and
// resolved one version at a time. Not populated for shows/tracks. Episode-level
// multi-version detection is handled separately by PlexEpisodeMediaVersion below —
// see CLAUDE.md's Duplicate detection section for why the two are asymmetric.
export interface PlexMediaVersion {
  mediaId: number;
  itemRatingKey: string;
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
  audioStreams: PlexMediaStreamSummary[];
  subtitleStreams: PlexMediaStreamSummary[];
  streamDetailsAvailable: boolean;
  fileSize: number | null;
}

// Absolute paths reported by Plex for a deletion confirmation preview. These are
// deliberately ephemeral and informational: callers must never treat them as local
// filesystem authority because they may name a remote host path, a container path, or
// a path that changed after this lookup.
export interface PlexMediaPathPreview {
  paths: string[];
  truncated: boolean;
}

export interface PlexMediaVersionPathPreview extends PlexMediaPathPreview {
  mediaId: number;
}

// One row per Plex `Media` entry on an episode — but only ever produced by
// mapEpisodeMediaVersions for episodes that already have 2+ valid Media entries (see
// episodeMediaVersions in db/schema.ts for why this is filtered at write time, unlike
// PlexMediaVersion above which is emitted unconditionally for every movie).
export interface PlexEpisodeMediaVersion {
  mediaId: number;
  episodeRatingKey: string;
  seasonRatingKey: string;
  showRatingKey: string;
  episodeTitle: string;
  episodeIndex: number;
  seasonIndex: number;
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
  audioStreams: PlexMediaStreamSummary[];
  subtitleStreams: PlexMediaStreamSummary[];
  streamDetailsAvailable: boolean;
  fileSize: number | null;
}

// History entry returned by /status/sessions/history/all — cross-user, all accounts.
// grandparentKey is a path ("/library/metadata/76749"), not a bare ratingKey.
// accountID is the PMS SystemAccount id. It matches users.accountId for non-owners;
// the server owner is the deliberate local id=1 exception.
export interface PlexHistoryEntry {
  ratingKey: string;
  historyKey?: string; // unique "/status/sessions/history/<id>" identity when supplied by PMS
  grandparentKey?: string; // "/library/metadata/<showRatingKey>" when type === 'episode'
  parentIndex?: number; // season number when type === 'episode'
  viewedAt?: number;
  accountID?: number;
}

// One row per account the PMS itself knows about — allocated lazily the first time
// that account actually connects/plays something, NOT at share-grant time. id 0 is
// always a nameless system/placeholder account; id 1 is always the server owner. Used
// only to confirm which plex.tv/Home account ids the PMS currently knows. For non-owner
// users, `id` is also the global roster id; the owner is the deliberate id=1 exception.
// `key` is merely the navigational path for this same id.
export interface PlexLocalAccount {
  id: number;
  name: string | null;
}

// Current playback returned by /status/sessions. Plex's session response is less
// formally documented than its webhook payload and has accumulated a few equivalent
// field names across server/client versions, so the mapper in client.ts normalizes
// those wire shapes into this deliberately small internal contract.
export interface PlexActiveSession {
  sessionKey: string;
  ratingKey: string;
  type: string;
  grandparentRatingKey: string | null;
  state: 'playing' | 'paused' | 'buffering';
  accountId: number | null;
  username: string | null;
  playerUuid: string | null;
  playerTitle: string | null;
  ip: string | null;
  isLocal: boolean | null;
}
