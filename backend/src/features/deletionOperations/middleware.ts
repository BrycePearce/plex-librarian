import type { Context, Next } from 'hono';
import { withTransaction } from '../../db/index.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import {
  DeletionConflictError,
  enqueueDeletionOperation,
  findWarningOverlap,
  locallyActiveServerId,
  type NewDeletionTarget,
  repeatedDeletionOperation,
} from './service.ts';
import {
  parseStaleQuickCleanupDays,
  validateStaleQuickCleanupSelection,
} from '../libraries/quickCleanup.ts';
import { activeWholeItemRatingKeys } from '../mediaDeletion/activePlayback.ts';
import type { StaleQuickCleanupCandidate } from '@plex-librarian/shared/types.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { buildVersionDeletionPlan } from '../mediaDeletion/versionPlanning.ts';
import type { PersistedArrReassignment } from '../mediaDeletion/arrReassignmentPlanning.ts';

const QUICK_CLEANUP_LIVE_READ_CONCURRENCY = 3;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function hasLiveMultiVersionTitle(
  candidates: ReadonlyMap<string, StaleQuickCleanupCandidate>,
  client: Pick<PlexClient, 'metadataIdentity' | 'showHasMultiVersionEpisodes'>,
): Promise<boolean> {
  const candidateList = [...candidates.values()];
  let nextIndex = 0;
  let found = false;
  const workers = Array.from(
    {
      length: Math.min(QUICK_CLEANUP_LIVE_READ_CONCURRENCY, candidateList.length),
    },
    async () => {
      while (!found && nextIndex < candidateList.length) {
        const candidate = candidateList[nextIndex++];
        const live = await client.metadataIdentity(candidate.ratingKey);
        if (!live) continue;
        if (
          (live.type === 'movie' && live.media.length >= 2) ||
          (live.type === 'show' && (await client.showHasMultiVersionEpisodes(candidate.ratingKey)))
        ) {
          found = true;
        }
      }
    },
  );
  await Promise.all(workers);
  return found;
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
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const clientRequestId = body.clientRequestId;
  if (typeof clientRequestId !== 'string') {
    return c.json({ error: 'clientRequestId is required' }, 400);
  }
  let activeServer: Awaited<ReturnType<typeof resolveActiveServer>> | null = null;
  const persistedServerId = locallyActiveServerId();
  if (persistedServerId === null) {
    activeServer = await resolveActiveServer().catch(() => null);
    if (activeServer === null) return c.json({ error: 'Plex is not configured' }, 404);
  }
  const serverId = persistedServerId ?? activeServer!.serverId;
  try {
    if (libraryMatch) {
      const libraryKey = decode(libraryMatch[1]);
      const ratingKeys = Array.isArray(body.ratingKeys)
        ? [...new Set(body.ratingKeys.filter((key): key is string => typeof key === 'string'))]
        : [];
      if (ratingKeys.length === 0 || ratingKeys.length > 200) {
        return c.json({ error: 'ratingKeys must contain between 1 and 200 strings' }, 400);
      }
      const quickCleanupDays = body.quickCleanupThresholdDays === undefined
        ? null
        : parseStaleQuickCleanupDays(body.quickCleanupThresholdDays);
      if (body.quickCleanupThresholdDays !== undefined && quickCleanupDays === null) {
        return c.json(
          {
            error: 'quickCleanupThresholdDays must be an integer between 180 and 3650',
          },
          400,
        );
      }
      const coordinated = new Set(
        Array.isArray(body.coordinatedRatingKeys)
          ? body.coordinatedRatingKeys.filter((key): key is string => typeof key === 'string')
          : body.mode === 'coordinated'
          ? ratingKeys
          : [],
      );
      const unmonitor = new Set(
        Array.isArray(body.unmonitorRatingKeys)
          ? body.unmonitorRatingKeys.filter((key): key is string => typeof key === 'string')
          : [],
      );
      if (
        [...coordinated, ...unmonitor].some((key) => !ratingKeys.includes(key)) ||
        [...unmonitor].some((key) => coordinated.has(key))
      ) {
        return c.json({ error: 'invalid whole-item destinations' }, 400);
      }
      const payload = {
        path,
        ratingKeys,
        coordinatedRatingKeys: [...coordinated].sort(),
        cleanupDownloads: body.cleanupDownloads === true,
        unmonitorRatingKeys: [...unmonitor].sort(),
        ...(quickCleanupDays !== null ? { quickCleanupThresholdDays: quickCleanupDays } : {}),
      };
      const repeated = await repeatedDeletionOperation(serverId, clientRequestId, payload);
      if (repeated) return c.json(repeated, 202);
      const warningOperationId = findWarningOverlap(serverId, 'whole_item', ratingKeys);
      if (warningOperationId) {
        throw new DeletionConflictError(
          'this item has unresolved Plex cleanup; retry Plex cleanup from Activity first',
          409,
          warningOperationId,
        );
      }
      activeServer ??= await resolveActiveServer().catch(() => null);
      if (activeServer === null) return c.json({ error: 'Plex is not configured' }, 404);
      if (activeServer.serverId !== serverId) {
        return c.json(
          {
            error: 'the active Plex server changed during deletion validation',
          },
          409,
        );
      }
      const serverUrl = activeServer.client.serverUrl;
      const initialQuickCleanupCandidates = quickCleanupDays === null
        ? null
        : validateStaleQuickCleanupSelection(serverId, libraryKey, quickCleanupDays, ratingKeys);
      if (quickCleanupDays !== null && initialQuickCleanupCandidates === null) {
        return c.json(
          {
            error: 'the quick cleanup plan changed; analyze stale items again before deleting',
          },
          409,
        );
      }
      if (
        initialQuickCleanupCandidates &&
        (await hasLiveMultiVersionTitle(initialQuickCleanupCandidates, activeServer.client))
      ) {
        return c.json(
          {
            error:
              'a selected title now has multiple versions; analyze stale items again before deleting',
          },
          409,
        );
      }
      const activeQuickCleanupSelection = quickCleanupDays === null
        ? new Set<string>()
        : activeWholeItemRatingKeys(
          new Set(ratingKeys),
          await activeServer.client.activeSessions(),
        );
      if (activeQuickCleanupSelection.size > 0) {
        return c.json(
          {
            error:
              'a selected title started playing; analyze stale items again after playback stops',
          },
          409,
        );
      }
      // The live Plex checks above yield to other sync work. Keep the authoritative local
      // eligibility read last so a duplicate/request/history change cannot slip through
      // that gap before the operation is enqueued.
      const quickCleanupCandidates = quickCleanupDays === null
        ? null
        : validateStaleQuickCleanupSelection(serverId, libraryKey, quickCleanupDays, ratingKeys);
      if (quickCleanupDays !== null && quickCleanupCandidates === null) {
        return c.json(
          {
            error: 'the quick cleanup plan changed; analyze stale items again before deleting',
          },
          409,
        );
      }
      const rows = withTransaction((client) => {
        const machine = client
          .prepare('SELECT machine_identifier FROM servers WHERE id = ?')
          .value<[string]>(serverId)?.[0];
        return ratingKeys.map((ratingKey) => {
          const item = client
            .prepare(
              'SELECT title, type, file_size, tmdb_id, tvdb_id FROM items WHERE server_id = ? AND library_key = ? AND rating_key = ?',
            )
            .value<[string, string, number | null, number | null, number | null]>(
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
        const quickCleanupCandidate = quickCleanupCandidates?.get(found.ratingKey);
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
            unmonitorFromArr: mode === 'plex-only' && unmonitor.has(found.ratingKey),
            selectedRatingKeys: mode === 'coordinated' ? coordinatedKeys : plexOnlyKeys,
            ...(quickCleanupCandidate
              ? {
                quickCleanupEvidence: {
                  thresholdDays: quickCleanupDays,
                  reason: quickCleanupCandidate.reason,
                  lastViewedAt: quickCleanupCandidate.lastViewedAt,
                  addedAt: quickCleanupCandidate.addedAt,
                },
              }
              : {}),
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
      ? Array.isArray(body.mediaIds)
        ? [
          ...new Set(
            body.mediaIds.filter((id): id is number => Number.isSafeInteger(id) && id >= 0),
          ),
        ]
        : []
      : [Number(match[2])];
    if (mediaIds.length === 0 || mediaIds.length > 50) {
      return c.json({ error: 'mediaIds must contain between 1 and 50 integers' }, 400);
    }
    if (body.arrMediaIds !== undefined || body.deleteFromArr !== undefined) {
      return c.json(
        {
          error: 'Arr handling for media versions is determined by the backend',
        },
        400,
      );
    }
    const cleanupMediaIds = new Set(
      Array.isArray(body.cleanupMediaIds)
        ? body.cleanupMediaIds.filter((id): id is number => Number.isSafeInteger(id) && id >= 0)
        : body.cleanupDownloads === true
        ? mediaIds
        : [],
    );
    if (body.planFingerprint !== undefined && typeof body.planFingerprint !== 'string') {
      return c.json({ error: 'planFingerprint must be a string' }, 400);
    }
    if (body.allowRadarrRetainedPathManagement !== undefined) {
      return c.json({ error: 'allowRadarrRetainedPathManagement is no longer supported' }, 400);
    }
    if (
      body.allowRadarrMovieRemoval !== undefined &&
      typeof body.allowRadarrMovieRemoval !== 'boolean'
    ) {
      return c.json({ error: 'allowRadarrMovieRemoval must be boolean' }, 400);
    }
    const requestedPlanFingerprint = typeof body.planFingerprint === 'string'
      ? body.planFingerprint
      : null;
    const allowRadarrMovieRemoval = body.allowRadarrMovieRemoval === true;
    if (body.unmonitorFromArr === true) {
      return c.json({ error: 'unmonitorFromArr is no longer supported for media versions' }, 400);
    }
    if ([...cleanupMediaIds].some((id) => !mediaIds.includes(id))) {
      return c.json({ error: 'invalid deletion destinations' }, 400);
    }
    const payload = {
      path,
      mediaIds,
      cleanupMediaIds: [...cleanupMediaIds].sort((a, b) => a - b),
      ...(requestedPlanFingerprint ? { planFingerprint: requestedPlanFingerprint } : {}),
      ...(allowRadarrMovieRemoval ? { allowRadarrMovieRemoval: true } : {}),
    };
    const repeated = await repeatedDeletionOperation(serverId, clientRequestId, payload);
    if (repeated) return c.json(repeated, 202);
    const warningOperationId = findWarningOverlap(serverId, kind, [ratingKey], mediaIds);
    if (warningOperationId) {
      throw new DeletionConflictError(
        'this item has unresolved Plex cleanup; retry Plex cleanup from Activity first',
        409,
        warningOperationId,
      );
    }
    activeServer ??= await resolveActiveServer().catch(() => null);
    if (activeServer === null) return c.json({ error: 'Plex is not configured' }, 404);
    if (activeServer.serverId !== serverId) {
      return c.json({ error: 'the active Plex server changed during deletion validation' }, 409);
    }
    const serverUrl = activeServer.client.serverUrl;
    const found = withTransaction((client) => {
      const machine = client
        .prepare('SELECT machine_identifier FROM servers WHERE id = ?')
        .value<[string]>(serverId)?.[0];
      return mediaIds.map((mediaId) => {
        if (kind === 'movie_version') {
          const row = client
            .prepare(
              'SELECT v.library_key, i.title, v.file_size FROM item_media_versions v JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.item_rating_key WHERE v.server_id = ? AND v.item_rating_key = ? AND v.media_id = ?',
            )
            .value<[string, string, number | null]>(serverId, ratingKey, mediaId);
          return row
            ? {
              mediaId,
              libraryKey: row[0],
              title: row[1],
              size: row[2],
              machine,
            }
            : null;
        }
        const row = client
          .prepare(
            'SELECT v.library_key, i.title, v.episode_title, v.file_size FROM episode_media_versions v JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.show_rating_key WHERE v.server_id = ? AND v.episode_rating_key = ? AND v.media_id = ?',
          )
          .value<[string, string, string, number | null]>(serverId, ratingKey, mediaId);
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
          const row = client
            .prepare(
              'SELECT i.type, i.tmdb_id, i.tvdb_id, v.video_resolution, v.bitrate, v.video_codec, v.container FROM item_media_versions v JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.item_rating_key WHERE v.server_id = ? AND v.item_rating_key = ? AND v.media_id = ?',
            )
            .value<
              [
                string,
                number | null,
                number | null,
                string | null,
                number | null,
                string | null,
                string | null,
              ]
            >(serverId, ratingKey, target.mediaId)!;
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
        const row = client
          .prepare(
            'SELECT i.tvdb_id, i.title, v.episode_title, v.show_rating_key, v.season_rating_key, v.season_index, v.episode_index, v.video_resolution, v.bitrate, v.video_codec, v.container FROM episode_media_versions v JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.show_rating_key WHERE v.server_id = ? AND v.episode_rating_key = ? AND v.media_id = ?',
          )
          .value<
            [
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
            ]
          >(serverId, ratingKey, target.mediaId)!;
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
    let acceptedPlan: Awaited<ReturnType<typeof buildVersionDeletionPlan>> | null = null;
    let acceptedReassignments: PersistedArrReassignment[] = [];
    if (kind === 'movie_version') {
      const activeMovies = activeWholeItemRatingKeys(
        new Set([ratingKey]),
        await activeServer.client.activeSessions(),
      );
      if (activeMovies.has(ratingKey)) {
        return c.json(
          {
            error: 'this movie started playing; preview the deletion again later',
          },
          409,
        );
      }
      const [liveVersions, arrTargets] = await Promise.all([
        activeServer.client.mediaVersionPathPreviews(ratingKey),
        getArrDeleteTargets(serverId, libraryKey),
      ]);
      const versionRanks = withTransaction((client) =>
        client
          .prepare(
            `SELECT media_id, video_resolution, height, bitrate, file_size
           FROM item_media_versions WHERE server_id = ? AND item_rating_key = ?`,
          )
          .values(serverId, ratingKey)
          .map((row) => ({
            mediaId: Number(row[0]),
            videoResolution: row[1] === null ? null : String(row[1]),
            height: row[2] === null ? null : Number(row[2]),
            bitrate: row[3] === null ? null : Number(row[3]),
            fileSize: row[4] === null ? null : Number(row[4]),
          }))
      );
      const item = enriched[0]!;
      acceptedPlan = await buildVersionDeletionPlan({
        mediaType: 'movie',
        item,
        selectedMediaIds: new Set(mediaIds),
        liveVersions,
        arrTargets,
        resolvedCleanup: null,
        cleanupConfigured: false,
        allowPartialCoverage: true,
        serverId,
        libraryKey,
        plexClient: activeServer.client,
        versionRanks,
      });
      const pathPreview = acceptedPlan.preview.radarrPathAdoption;
      const outsideMode = pathPreview.mode === 'adopt_safe_path';
      if (outsideMode) {
        if (
          !pathPreview.planFingerprint ||
          requestedPlanFingerprint !== pathPreview.planFingerprint
        ) {
          return c.json(
            {
              error: 'the Radarr retained-path plan changed; preview the deletion again',
            },
            409,
          );
        }
        if (allowRadarrMovieRemoval) {
          return c.json({ error: 'Radarr movie-removal authorization is not valid here' }, 400);
        }
      } else if (pathPreview.mode === 'remove_from_radarr') {
        if (
          !pathPreview.planFingerprint ||
          requestedPlanFingerprint !== pathPreview.planFingerprint
        ) {
          return c.json(
            {
              error: 'the Radarr movie-removal plan changed; preview the deletion again',
            },
            409,
          );
        }
        if (!allowRadarrMovieRemoval) {
          return c.json({ error: 'Radarr movie removal must be explicitly authorized' }, 400);
        }
      } else if (requestedPlanFingerprint || allowRadarrMovieRemoval) {
        return c.json({ error: 'Radarr path-adoption authorization is not valid here' }, 400);
      }
      if (
        acceptedPlan.arrManagedMediaIds.some((mediaId) => mediaIds.includes(mediaId)) &&
        acceptedPlan.preview.arrReassignStatus !== 'resolved' &&
        pathPreview.mode !== 'remove_from_radarr'
      ) {
        return c.json(
          {
            error: acceptedPlan.preview.arrReassignReason ??
              'Radarr cannot safely adopt the retained Plex version',
          },
          409,
        );
      }
      const retainedMediaId = pathPreview.retainedMediaId;
      if (retainedMediaId !== undefined && pathPreview.mode !== 'remove_from_radarr') {
        acceptedReassignments = acceptedPlan.eligibleArrReassignments.map((entry) => {
          const retainedPath = entry.candidatePaths.get(retainedMediaId);
          const retainedRecordPath = entry.candidateRecordPaths.get(retainedMediaId);
          if (
            !retainedPath ||
            !retainedRecordPath ||
            entry.managedFileId === null ||
            entry.managedPath === null
          ) {
            throw new Error('The accepted Radarr reassignment identity is incomplete');
          }
          return {
            instanceId: entry.target.instanceId,
            instanceType: entry.target.instanceType,
            instanceUrl: entry.target.instanceUrl,
            configurationUpdatedAt: entry.target.configurationUpdatedAt,
            mappingIdentity: entry.target.mappingIdentity,
            recordId: entry.recordId,
            recordPath: entry.recordPath,
            episodeId: entry.episodeId,
            managedFileId: entry.managedFileId,
            managedPath: entry.managedPath,
            retainedMediaId,
            retainedPath,
            retainedRecordPath,
            retainedFileSize: entry.candidateFileSizes.get(retainedMediaId) ?? null,
            originalMonitored: entry.monitored,
            ...(entry.radarrPathPlan ? { radarrPathPlan: entry.radarrPathPlan } : {}),
          } satisfies PersistedArrReassignment;
        });
      }
    } else if (requestedPlanFingerprint || allowRadarrMovieRemoval) {
      return c.json({ error: 'Radarr path adoption is unavailable for Sonarr episodes' }, 400);
    }
    const targets: NewDeletionTarget[] = enriched.map((target) => {
      const reassignment = acceptedReassignments.find(
        (entry) =>
          acceptedPlan?.arrManagedMediaIds.includes(target.mediaId) && entry.managedFileId !== null,
      );
      const removalFallback =
        acceptedPlan?.radarrRemovalFallback?.selectedMediaId === target.mediaId
          ? {
            ...acceptedPlan.radarrRemovalFallback,
            userAuthorizedRadarrRemoval: true as const,
          }
          : undefined;
      const reservationFingerprint = reassignment?.radarrPathPlan?.planFingerprint ??
        removalFallback?.planFingerprint ??
        (reassignment
          ? `existing-path:${reassignment.instanceId}:${reassignment.recordId}:${reassignment.retainedMediaId}`
          : null);
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
          cleanupDownloads: cleanupMediaIds.has(target.mediaId),
          selectedMediaIds: [target.mediaId],
          operationMediaIds: mediaIds,
          ...(reassignment && acceptedPlan
            ? {
              arrReassignmentMappings: acceptedPlan.arrMappingIdentities,
              arrOwnerships: acceptedPlan.arrOwnerships,
              arrReassignments: [reassignment],
            }
            : {}),
          ...(removalFallback && acceptedPlan
            ? {
              arrReassignmentMappings: acceptedPlan.arrMappingIdentities,
              arrOwnerships: acceptedPlan.arrOwnerships,
              radarrRemovalFallback: removalFallback,
            }
            : {}),
        },
        reservation: {
          mediaKind: kind === 'movie_version' ? 'movie' : 'episode',
          mediaId: target.mediaId,
          ratingKey,
        },
        ...((reassignment || removalFallback) && reservationFingerprint
          ? {
            radarrReservation: {
              arrInstanceId: reassignment?.instanceId ?? removalFallback!.arrInstanceId,
              movieId: reassignment?.recordId ?? removalFallback!.movieId,
              planFingerprint: reservationFingerprint,
            },
          }
          : {}),
      };
    });
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
      return c.json(
        {
          error: error.message,
          ...(error.operationId ? { operationId: error.operationId } : {}),
        },
        error.status as 400 | 409,
      );
    }
    throw error;
  }
}
