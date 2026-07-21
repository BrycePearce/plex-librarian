import type { Context, Next } from 'hono';
import { withTransaction } from '../../db/index.ts';
import { getActiveServerIdOrNull, resolveActiveServer } from '../../integrations/plex/index.ts';
import {
  DeletionConflictError,
  enqueueDeletionOperation,
  type NewDeletionTarget,
  repeatedDeletionOperation,
} from './service.ts';

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function durableDeletionAdapter(c: Context, next: Next): Promise<Response | void> {
  if (c.req.method !== 'DELETE') {
    await next();
    return;
  }
  const path = c.req.path;
  const libraryMatch = path.match(/^\/api\/libraries\/([^/]+)\/items$/);
  const movieBatchMatch = path.match(/^\/api\/duplicates\/movies\/([^/]+)\/media$/);
  const movieMatch = path.match(/^\/api\/duplicates\/movies\/([^/]+)\/media\/(\d+)$/);
  const episodeBatchMatch = path.match(/^\/api\/duplicates\/episodes\/([^/]+)\/media$/);
  const episodeMatch = path.match(/^\/api\/duplicates\/episodes\/([^/]+)\/media\/(\d+)$/);
  if (!libraryMatch && !movieBatchMatch && !movieMatch && !episodeBatchMatch && !episodeMatch) {
    await next();
    return;
  }
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const clientRequestId = body.clientRequestId;
  if (typeof clientRequestId !== 'string') {
    return c.json({ error: 'clientRequestId is required' }, 400);
  }
  const serverId = await getActiveServerIdOrNull();
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 404);
  const serverUrl = (await resolveActiveServer()).client.serverUrl;
  try {
    if (libraryMatch) {
      const libraryKey = decode(libraryMatch[1]);
      const ratingKeys = Array.isArray(body.ratingKeys)
        ? [...new Set(body.ratingKeys.filter((key): key is string => typeof key === 'string'))]
        : [];
      if (ratingKeys.length === 0 || ratingKeys.length > 200) {
        return c.json({ error: 'ratingKeys must contain between 1 and 200 strings' }, 400);
      }
      const coordinated = new Set(
        Array.isArray(body.coordinatedRatingKeys)
          ? body.coordinatedRatingKeys.filter((key): key is string => typeof key === 'string')
          : body.mode === 'coordinated'
          ? ratingKeys
          : [],
      );
      const payload = {
        path,
        ratingKeys,
        coordinatedRatingKeys: [...coordinated].sort(),
        cleanupDownloads: body.cleanupDownloads === true,
      };
      const repeated = await repeatedDeletionOperation(serverId, clientRequestId, payload);
      if (repeated) return c.json(repeated, 202);
      const rows = withTransaction((client) => {
        const machine = client.prepare('SELECT machine_identifier FROM servers WHERE id = ?').value<
          [string]
        >(serverId)?.[0];
        return ratingKeys.map((ratingKey) => {
          const item = client.prepare(
            'SELECT title, type, file_size, tmdb_id, tvdb_id FROM items WHERE server_id = ? AND library_key = ? AND rating_key = ?',
          ).value<[string, string, number | null, number | null, number | null]>(
            serverId,
            libraryKey,
            ratingKey,
          );
          return item ? { ratingKey, machine, item } : null;
        });
      });
      if (rows.some((row) => row === null)) {
        return c.json({ error: 'one or more items were not found in this library' }, 404);
      }
      const coordinatedKeys = ratingKeys.filter((key) => coordinated.has(key));
      const plexOnlyKeys = ratingKeys.filter((key) => !coordinated.has(key));
      const targets: NewDeletionTarget[] = rows.map((row) => {
        const found = row!;
        const mode = coordinated.has(found.ratingKey) ? 'coordinated' : 'plex-only';
        return {
          kind: 'whole_item',
          key: found.ratingKey,
          title: found.item[0],
          logicalSize: found.item[2],
          snapshot: {
            machineIdentifier: found.machine,
            serverUrl,
            libraryKey,
            ratingKey: found.ratingKey,
            title: found.item[0],
            type: found.item[1],
            tmdbId: found.item[3],
            tvdbId: found.item[4],
            mode,
            cleanupDownloads: mode === 'coordinated' && body.cleanupDownloads === true,
            selectedRatingKeys: mode === 'coordinated' ? coordinatedKeys : plexOnlyKeys,
          },
        };
      });
      const result = await enqueueDeletionOperation({
        clientRequestId,
        serverId,
        libraryKey,
        kind: 'whole_item',
        payload,
        targets,
      });
      return c.json(result, 202);
    }

    const match = movieBatchMatch ?? movieMatch ?? episodeBatchMatch ?? episodeMatch!;
    const ratingKey = decode(match[1]);
    const kind = episodeBatchMatch || episodeMatch ? 'episode_version' : 'movie_version';
    const mediaIds = movieBatchMatch || episodeBatchMatch
      ? (Array.isArray(body.mediaIds)
        ? [
          ...new Set(
            body.mediaIds.filter((id): id is number => Number.isSafeInteger(id) && id >= 0),
          ),
        ]
        : [])
      : [Number(match[2])];
    if (mediaIds.length === 0 || mediaIds.length > 50) {
      return c.json({ error: 'mediaIds must contain between 1 and 50 integers' }, 400);
    }
    const arrMediaIds = new Set(
      Array.isArray(body.arrMediaIds)
        ? body.arrMediaIds.filter((id): id is number => Number.isSafeInteger(id) && id >= 0)
        : body.deleteFromArr === true
        ? mediaIds
        : [],
    );
    const cleanupMediaIds = new Set(
      Array.isArray(body.cleanupMediaIds)
        ? body.cleanupMediaIds.filter((id): id is number => Number.isSafeInteger(id) && id >= 0)
        : body.cleanupDownloads === true
        ? mediaIds
        : [],
    );
    if (
      [...arrMediaIds, ...cleanupMediaIds].some((id) => !mediaIds.includes(id)) ||
      [...cleanupMediaIds].some((id) => !arrMediaIds.has(id))
    ) {
      return c.json({ error: 'destination media IDs must be selected media IDs' }, 400);
    }
    const payload = {
      path,
      mediaIds,
      arrMediaIds: [...arrMediaIds].sort((a, b) => a - b),
      cleanupMediaIds: [...cleanupMediaIds].sort((a, b) => a - b),
    };
    const repeated = await repeatedDeletionOperation(serverId, clientRequestId, payload);
    if (repeated) return c.json(repeated, 202);
    const found = withTransaction((client) => {
      const machine = client.prepare('SELECT machine_identifier FROM servers WHERE id = ?').value<
        [string]
      >(serverId)?.[0];
      return mediaIds.map((mediaId) => {
        if (kind === 'movie_version') {
          const row = client.prepare(
            'SELECT v.library_key, i.title, v.file_size FROM item_media_versions v JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.item_rating_key WHERE v.server_id = ? AND v.item_rating_key = ? AND v.media_id = ?',
          ).value<[string, string, number | null]>(serverId, ratingKey, mediaId);
          return row ? { mediaId, libraryKey: row[0], title: row[1], size: row[2], machine } : null;
        }
        const row = client.prepare(
          'SELECT v.library_key, i.title, v.episode_title, v.file_size FROM episode_media_versions v JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.show_rating_key WHERE v.server_id = ? AND v.episode_rating_key = ? AND v.media_id = ?',
        ).value<[string, string, string, number | null]>(serverId, ratingKey, mediaId);
        if (!row) return null;
        return {
          mediaId,
          libraryKey: row[0],
          title: `${row[1]} — ${row[2]}`,
          size: row[3],
          machine,
        };
      });
    });
    if (found.some((row) => row === null)) {
      return c.json({ error: 'one or more media versions were not found' }, 404);
    }
    const enriched = withTransaction((client) =>
      found.map((base) => {
        const target = base!;
        if (kind === 'movie_version') {
          const row = client.prepare(
            'SELECT i.type, i.tmdb_id, i.tvdb_id, v.video_resolution, v.bitrate, v.video_codec, v.container FROM item_media_versions v JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.item_rating_key WHERE v.server_id = ? AND v.item_rating_key = ? AND v.media_id = ?',
          ).value<[
            string,
            number | null,
            number | null,
            string | null,
            number | null,
            string | null,
            string | null,
          ]>(serverId, ratingKey, target.mediaId)!;
          return {
            ...target,
            type: row[0],
            tmdbId: row[1],
            tvdbId: row[2],
            videoResolution: row[3],
            bitrate: row[4],
            videoCodec: row[5],
            container: row[6],
            showTitle: null,
            episodeTitle: null,
            showRatingKey: null,
            seasonRatingKey: null,
            seasonIndex: null,
            episodeIndex: null,
          };
        }
        const row = client.prepare(
          'SELECT i.tvdb_id, i.title, v.episode_title, v.show_rating_key, v.season_rating_key, v.season_index, v.episode_index, v.video_resolution, v.bitrate, v.video_codec, v.container FROM episode_media_versions v JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.show_rating_key WHERE v.server_id = ? AND v.episode_rating_key = ? AND v.media_id = ?',
        ).value<[
          number | null,
          string,
          string,
          string,
          string,
          number,
          number,
          string | null,
          number | null,
          string | null,
          string | null,
        ]>(serverId, ratingKey, target.mediaId)!;
        return {
          ...target,
          type: 'episode',
          tmdbId: null,
          tvdbId: row[0],
          showTitle: row[1],
          episodeTitle: row[2],
          showRatingKey: row[3],
          seasonRatingKey: row[4],
          seasonIndex: row[5],
          episodeIndex: row[6],
          videoResolution: row[7],
          bitrate: row[8],
          videoCodec: row[9],
          container: row[10],
        };
      })
    );
    const libraryKey = enriched[0].libraryKey;
    if (found.some((row) => row!.libraryKey !== libraryKey)) {
      return c.json({ error: 'targets must belong to one library' }, 409);
    }
    const targets: NewDeletionTarget[] = enriched.map((target) => {
      return {
        kind,
        key: `${ratingKey}:${target.mediaId}`,
        title: target.title,
        logicalSize: target.size,
        snapshot: {
          machineIdentifier: target.machine,
          serverUrl,
          libraryKey,
          ratingKey,
          mediaId: target.mediaId,
          title: target.title,
          type: target.type,
          tmdbId: target.tmdbId,
          tvdbId: target.tvdbId,
          fileSize: target.size,
          videoResolution: target.videoResolution,
          bitrate: target.bitrate,
          videoCodec: target.videoCodec,
          container: target.container,
          showTitle: target.showTitle,
          episodeTitle: target.episodeTitle,
          showRatingKey: target.showRatingKey,
          seasonRatingKey: target.seasonRatingKey,
          seasonIndex: target.seasonIndex,
          episodeIndex: target.episodeIndex,
          deleteFromArr: arrMediaIds.has(target.mediaId),
          cleanupDownloads: cleanupMediaIds.has(target.mediaId),
          selectedMediaIds: [target.mediaId],
        },
        reservation: {
          mediaKind: kind === 'movie_version' ? 'movie' : 'episode',
          mediaId: target.mediaId,
          ratingKey,
        },
      };
    });
    // Plex-only versions run first. A coordinated Radarr target may safely be the final
    // live version because Radarr removes the title rather than calling Plex's
    // last-version endpoint; keeping it last also leaves a recoverable copy if its
    // execution-time verification fails.
    targets.sort((a, b) =>
      Number(a.snapshot.deleteFromArr === true) - Number(b.snapshot.deleteFromArr === true)
    );
    const result = await enqueueDeletionOperation({
      clientRequestId,
      serverId,
      libraryKey,
      kind,
      payload,
      targets,
    });
    return c.json(result, 202);
  } catch (error) {
    if (error instanceof DeletionConflictError) {
      return c.json({ error: error.message }, error.status as 400 | 409);
    }
    throw error;
  }
}
