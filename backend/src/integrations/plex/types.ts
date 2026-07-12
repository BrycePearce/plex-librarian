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
  // Episode-level parent references — only present on type=4 responses.
  parentRatingKey?: string; // season ratingKey
  parentIndex?: number; // season number
  parentTitle?: string; // season title
  grandparentRatingKey?: string; // show ratingKey
  index?: number; // episode number within season — only present on type=4 responses, like parentIndex
  Media?: Array<{
    id?: number;
    videoResolution?: string;
    bitrate?: number;
    videoCodec?: string;
    container?: string;
    Part?: Array<{ size?: number }>;
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
  bitrate: number | null;
  videoCodec: string | null;
  container: string | null;
  fileSize: number | null;
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
  bitrate: number | null;
  videoCodec: string | null;
  container: string | null;
  fileSize: number | null;
}

// History entry returned by /status/sessions/history/all — cross-user, all accounts.
// grandparentKey is a path ("/library/metadata/76749"), not a bare ratingKey.
// accountID is the PMS-LOCAL account id (see users.localAccountId in schema.ts for why
// this is a different id space than the plex.tv global account id used elsewhere).
export interface PlexHistoryEntry {
  ratingKey: string;
  grandparentKey?: string; // "/library/metadata/<showRatingKey>" when type === 'episode'
  viewedAt?: number;
  accountID?: number;
}

// One row per account the PMS itself knows about — allocated lazily the first time
// that account actually connects/plays something, NOT at share-grant time. id 0 is
// always a nameless system/placeholder account; id 1 is always the server owner. Used
// only to reconcile the PMS-local id (which webhook/history events report) against the
// plex.tv global account id (which the roster in plexUsers.ts reports) by username
// match — see users.localAccountId in schema.ts.
export interface PlexLocalAccount {
  id: number;
  name: string;
}
