import { withTransaction } from '../../db/index.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { PlexMetadataIdentity } from '../../integrations/plex/types.ts';

export interface DurableTargetRecord {
  id: number;
  targetKind: 'whole_item' | 'movie_version' | 'episode_version';
  snapshot: string;
}

export interface DurableTargetSnapshot {
  machineIdentifier: string;
  serverUrl: string;
  libraryKey: string;
  ratingKey: string;
  title: string;
  type: string;
  tmdbId: number | null;
  tvdbId: number | null;
  mode?: 'coordinated' | 'plex-only';
  cleanupDownloads?: boolean;
  selectedRatingKeys?: string[];
  selectedMediaIds?: number[];
  mediaId?: number;
  fileSize?: number | null;
  videoResolution?: string | null;
  bitrate?: number | null;
  videoCodec?: string | null;
  container?: string | null;
  showTitle?: string | null;
  episodeTitle?: string | null;
  showRatingKey?: string | null;
  seasonRatingKey?: string | null;
  seasonIndex?: number | null;
  episodeIndex?: number | null;
  deleteFromArr?: boolean;
}

export class DeletionValidationError extends Error {}

function mismatch(label: string): never {
  throw new DeletionValidationError(`${label} changed after deletion was accepted`);
}

function equalNullable(expected: unknown, actual: unknown, label: string): void {
  if (expected !== null && expected !== undefined && expected !== actual) mismatch(label);
}

function validateLiveItem(snapshot: DurableTargetSnapshot, live: PlexMetadataIdentity): void {
  if (live.ratingKey !== snapshot.ratingKey) mismatch('Plex rating key');
  if (live.type !== snapshot.type) mismatch('Plex media type');
  if (live.title !== (snapshot.episodeTitle ?? snapshot.title)) mismatch('Plex title');
  if (live.librarySectionId !== null && live.librarySectionId !== snapshot.libraryKey) {
    mismatch('Plex library ownership');
  }
  if (snapshot.type !== 'episode') {
    equalNullable(snapshot.tmdbId, live.tmdbId, 'TMDB identity');
    equalNullable(snapshot.tvdbId, live.tvdbId, 'TVDB identity');
  }
}

function validateLocalTarget(
  serverId: number,
  kind: DurableTargetRecord['targetKind'],
  snapshot: DurableTargetSnapshot,
): void {
  const row = withTransaction((client) => {
    if (kind === 'whole_item') {
      return client.prepare(
        'SELECT library_key, title, type, tmdb_id, tvdb_id FROM items WHERE server_id = ? AND rating_key = ?',
      ).value<unknown[]>(serverId, snapshot.ratingKey);
    }
    if (kind === 'movie_version') {
      return client.prepare(
        'SELECT v.library_key, i.title, i.type, i.tmdb_id, i.tvdb_id, v.file_size, v.video_resolution, v.bitrate, v.video_codec, v.container FROM item_media_versions v JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.item_rating_key WHERE v.server_id = ? AND v.item_rating_key = ? AND v.media_id = ?',
      ).value<unknown[]>(serverId, snapshot.ratingKey, snapshot.mediaId!);
    }
    return client.prepare(
      'SELECT v.library_key, v.episode_title, v.show_rating_key, v.season_rating_key, v.season_index, v.episode_index, v.file_size, v.video_resolution, v.bitrate, v.video_codec, v.container FROM episode_media_versions v WHERE v.server_id = ? AND v.episode_rating_key = ? AND v.media_id = ?',
    ).value<unknown[]>(serverId, snapshot.ratingKey, snapshot.mediaId!);
  });
  if (!row) throw new DeletionValidationError('local target disappeared before finalization');
  if (row[0] !== snapshot.libraryKey) mismatch('local library ownership');
  if (kind === 'whole_item') {
    if (row[1] !== snapshot.title || row[2] !== snapshot.type) mismatch('local item identity');
    equalNullable(snapshot.tmdbId, row[3], 'local TMDB identity');
    equalNullable(snapshot.tvdbId, row[4], 'local TVDB identity');
    return;
  }
  if (kind === 'movie_version') {
    if (row[1] !== snapshot.title || row[2] !== snapshot.type) mismatch('local movie identity');
    equalNullable(snapshot.tmdbId, row[3], 'local TMDB identity');
    equalNullable(snapshot.tvdbId, row[4], 'local TVDB identity');
    for (
      const [index, key] of ['fileSize', 'videoResolution', 'bitrate', 'videoCodec', 'container']
        .entries()
    ) {
      equalNullable(
        snapshot[key as keyof DurableTargetSnapshot],
        row[index + 5],
        `local version ${key}`,
      );
    }
    return;
  }
  const expected = [
    snapshot.episodeTitle,
    snapshot.showRatingKey,
    snapshot.seasonRatingKey,
    snapshot.seasonIndex,
    snapshot.episodeIndex,
    snapshot.fileSize,
    snapshot.videoResolution,
    snapshot.bitrate,
    snapshot.videoCodec,
    snapshot.container,
  ];
  expected.forEach((value, index) =>
    equalNullable(value, row[index + 1], 'local episode identity')
  );
}

export async function validateDeletionTarget(
  serverId: number,
  target: DurableTargetRecord,
): Promise<{
  client: PlexClient;
  snapshot: DurableTargetSnapshot;
  live: PlexMetadataIdentity | null;
}> {
  const active = await resolveActiveServer();
  if (active.serverId !== serverId) {
    throw new DeletionValidationError('the active Plex server changed after deletion was accepted');
  }
  const snapshot = JSON.parse(target.snapshot) as DurableTargetSnapshot;
  if (snapshot.serverUrl !== active.client.serverUrl) mismatch('Plex server address');
  if (await active.client.identity() !== snapshot.machineIdentifier) {
    mismatch('Plex machine identity');
  }
  validateLocalTarget(serverId, target.targetKind, snapshot);

  const live = await active.client.metadataIdentity(snapshot.ratingKey);
  if (!live) return { client: active.client, snapshot, live: null };
  validateLiveItem(snapshot, live);
  if (target.targetKind === 'episode_version') {
    if (
      live.grandparentRatingKey !== snapshot.showRatingKey ||
      live.parentRatingKey !== snapshot.seasonRatingKey ||
      live.seasonIndex !== snapshot.seasonIndex ||
      live.index !== snapshot.episodeIndex
    ) mismatch('Plex episode ancestry');
    const show = await active.client.metadataIdentity(snapshot.showRatingKey!);
    if (!show || show.title !== snapshot.showTitle) mismatch('Plex show identity');
    equalNullable(snapshot.tvdbId, show.tvdbId, 'Plex show TVDB identity');
  }
  return { client: active.client, snapshot, live };
}
