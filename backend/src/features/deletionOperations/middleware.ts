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
import {
  buildVersionDeletionPlan,
  episodeVersionSonarrPlanFingerprint,
  selectVersionDownloadCleanup,
} from '../mediaDeletion/versionPlanning.ts';
import type { PersistedArrReassignment } from '../mediaDeletion/arrReassignmentPlanning/types.ts';
import {
  assertDownloadJobSelectionConsistent,
  loadAttemptedArrInstancesByItem,
  loadAttemptedDownloadJobKeysByItem,
  loadAttemptedOrphanFilesByItem,
  resolveWholeItemDownloadCleanupBatch,
} from '../mediaDeletion/planning.ts';
import { getDownloadClientTargets } from '../mediaDeletion/targets.ts';
import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';
import {
  bindSonarrPathOwnership,
  cleanupAuthorizationFingerprint,
  cleanupHasDurableAcceptedIdentity,
  cleanupIsEligible,
  persistResolvedCleanupIdentity,
  publicSonarrHistoricalPaths,
  reconcileSharedDownloadCleanups,
  type ResolvedCleanupItem,
  resolveDownloadCleanup,
  scopeSonarrReclamation,
} from '../mediaDeletion/cleanup.ts';

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
      if (body.cleanupDownloads !== undefined) {
        return c.json(
          { error: 'cleanupDownloadRatingKeys must be used for whole-item cleanup selection' },
          400,
        );
      }
      if (
        body.cleanupDownloadRatingKeys !== undefined &&
        (!Array.isArray(body.cleanupDownloadRatingKeys) ||
          !body.cleanupDownloadRatingKeys.every((key) => typeof key === 'string'))
      ) {
        return c.json({ error: 'cleanupDownloadRatingKeys must be an array of strings' }, 400);
      }
      if (
        body.cleanupPreviewFingerprints !== undefined &&
        (body.cleanupPreviewFingerprints === null ||
          Array.isArray(body.cleanupPreviewFingerprints) ||
          typeof body.cleanupPreviewFingerprints !== 'object' ||
          Object.values(body.cleanupPreviewFingerprints).some((value) =>
            typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)
          ))
      ) {
        return c.json(
          { error: 'cleanupPreviewFingerprints must map rating keys to fingerprints' },
          400,
        );
      }
      if (
        body.coordinatedRatingKeys !== undefined &&
        (!Array.isArray(body.coordinatedRatingKeys) ||
          !body.coordinatedRatingKeys.every((key) => typeof key === 'string'))
      ) {
        return c.json({ error: 'coordinatedRatingKeys must be an array of strings' }, 400);
      }
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
      const cleanupDownloadRatingKeys = new Set(
        Array.isArray(body.cleanupDownloadRatingKeys)
          ? body.cleanupDownloadRatingKeys.filter((key): key is string => typeof key === 'string')
          : [],
      );
      const cleanupPreviewFingerprints = body.cleanupPreviewFingerprints as
        | Record<string, string>
        | undefined;
      if (cleanupDownloadRatingKeys.size > 0 && !cleanupPreviewFingerprints) {
        return c.json({ error: 'cleanup preview changed; review the deletion again' }, 409);
      }
      if (
        [...coordinated, ...unmonitor, ...cleanupDownloadRatingKeys].some((key) =>
          !ratingKeys.includes(key)
        ) ||
        [...unmonitor].some((key) => coordinated.has(key))
      ) {
        return c.json({ error: 'invalid whole-item destinations' }, 400);
      }
      const payload = {
        path,
        ratingKeys,
        coordinatedRatingKeys: [...coordinated].sort(),
        cleanupDownloadRatingKeys: [...cleanupDownloadRatingKeys].sort(),
        cleanupPreviewFingerprints: Object.fromEntries(
          Object.keys(cleanupPreviewFingerprints ?? {}).sort().map((key) => [
            key,
            cleanupPreviewFingerprints![key],
          ]),
        ),
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
              `SELECT title, type, file_size, tmdb_id, tvdb_id FROM items i
               WHERE server_id = ? AND library_key = ? AND rating_key = ?
                 AND NOT EXISTS (SELECT 1 FROM ignored_content ignored
                   WHERE ignored.server_id = i.server_id AND ignored.rating_key = i.rating_key)`,
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
      let acceptedCleanups = new Map<string, ResolvedCleanupItem>();
      const sonarrOwnedRatingKeys = new Set(
        rows.flatMap((row) =>
          row!.item[1] === 'show' && coordinated.has(row!.ratingKey) ? [row!.ratingKey] : []
        ),
      );
      const cleanupInspectionKeys = new Set([
        ...cleanupDownloadRatingKeys,
        ...sonarrOwnedRatingKeys,
      ]);
      const submittedFingerprintKeys = Object.keys(cleanupPreviewFingerprints ?? {});
      if (
        submittedFingerprintKeys.length !== cleanupInspectionKeys.size ||
        submittedFingerprintKeys.some((key) => !cleanupInspectionKeys.has(key))
      ) {
        return c.json({ error: 'cleanup preview changed; review the deletion again' }, 409);
      }
      if (cleanupInspectionKeys.size > 0) {
        const selectedItems = rows.map((row) => ({
          ratingKey: row!.ratingKey,
          title: row!.item[0],
          type: row!.item[1],
          tmdbId: row!.item[3],
          tvdbId: row!.item[4],
        }));
        const [arrTargets, downloadTargets] = await Promise.all([
          getArrDeleteTargets(serverId, libraryKey),
          getDownloadClientTargets(serverId),
        ]);
        const [attemptedJobs, attemptedOrphans, attemptedArr] = await Promise.all([
          loadAttemptedDownloadJobKeysByItem(serverId, ratingKeys),
          loadAttemptedOrphanFilesByItem(serverId, ratingKeys),
          loadAttemptedArrInstancesByItem(
            serverId,
            selectedItems,
            arrTargets.map((target) => target.instanceId),
          ),
        ]);
        const rawCleanups = await resolveWholeItemDownloadCleanupBatch(
          serverId,
          libraryKey,
          selectedItems,
          arrTargets,
          downloadTargets,
          activeServer.client,
          attemptedJobs,
          attemptedOrphans,
          attemptedArr,
        );
        try {
          assertDownloadJobSelectionConsistent(rawCleanups, cleanupDownloadRatingKeys);
        } catch (error) {
          throw new DeletionConflictError(
            error instanceof Error ? error.message : 'qBittorrent selection is inconsistent',
            409,
          );
        }
        const reconciled = reconcileSharedDownloadCleanups(rawCleanups);
        acceptedCleanups = new Map(
          await Promise.all(reconciled.map(async (cleanup) =>
            [
              cleanup.ratingKey,
              rows.find((row) => row!.ratingKey === cleanup.ratingKey)!.item[1] === 'show'
                ? await bindSonarrPathOwnership(
                  cleanup,
                  downloadTargets,
                  cleanupDownloadRatingKeys.has(cleanup.ratingKey),
                )
                : cleanup,
            ] as const
          )),
        );
        for (const ratingKey of cleanupInspectionKeys) {
          const cleanup = acceptedCleanups.get(ratingKey);
          if (
            !cleanup ||
            (cleanupDownloadRatingKeys.has(ratingKey) &&
              (!cleanupIsEligible(cleanup) ||
                (!sonarrOwnedRatingKeys.has(ratingKey) &&
                  rows.find((row) => row!.ratingKey === ratingKey)!.item[1] === 'show' &&
                  cleanup.downloadJobs.length === 0)))
          ) {
            return c.json({
              error: cleanup &&
                  !sonarrOwnedRatingKeys.has(ratingKey) &&
                  cleanup.sonarrReclamation !== undefined &&
                  cleanup.orphanFiles.length > 0 &&
                  cleanup.downloadJobs.length === 0
                ? 'Verified orphan hardlink cleanup requires coordinated Sonarr deletion'
                : cleanup?.reason ?? 'No verified download job or orphan hardlink is available',
            }, 409);
          }
          if (sonarrOwnedRatingKeys.has(ratingKey) && cleanup.status === 'error') {
            return c.json({ error: cleanup.reason ?? 'Sonarr path ownership is unsafe' }, 409);
          }
          if (
            await cleanupAuthorizationFingerprint(cleanup) !==
              cleanupPreviewFingerprints?.[ratingKey]
          ) {
            return c.json({ error: 'cleanup preview changed; review the deletion again' }, 409);
          }
        }
        acceptedCleanups = new Map([...acceptedCleanups].map(([ratingKey, cleanup]) => {
          const row = rows.find((candidate) => candidate!.ratingKey === ratingKey)!;
          return row.item[1] === 'show' && !sonarrOwnedRatingKeys.has(ratingKey)
            ? [ratingKey, { ...cleanup, orphanFiles: [], sonarrReclamation: undefined }]
            : [ratingKey, cleanup];
        }));
      }
      const sortedCleanupKeys = [...cleanupDownloadRatingKeys].sort();
      const targets: NewDeletionTarget[] = rows.map((row) => {
        const found = row!;
        const mode = coordinated.has(found.ratingKey) ? 'coordinated' : 'plex-only';
        const quickCleanupCandidate = quickCleanupCandidates?.get(found.ratingKey);
        const acceptedCleanup = acceptedCleanups.get(found.ratingKey);
        const persistAcceptedCleanup = (cleanupDownloadRatingKeys.has(found.ratingKey) ||
          sonarrOwnedRatingKeys.has(found.ratingKey)) &&
          acceptedCleanup !== undefined && cleanupHasDurableAcceptedIdentity(acceptedCleanup);
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
            cleanupDownloads: cleanupDownloadRatingKeys.has(found.ratingKey),
            unmonitorFromArr: mode === 'plex-only' && unmonitor.has(found.ratingKey),
            selectedRatingKeys: [...ratingKeys],
            cleanupDownloadRatingKeys: sortedCleanupKeys,
            ...(persistAcceptedCleanup
              ? {
                wholeItemDownloadCleanup: persistResolvedCleanupIdentity(
                  acceptedCleanup,
                ),
              }
              : {}),
            ...(sonarrOwnedRatingKeys.has(found.ratingKey) && acceptedCleanup
              ? { sonarrHistoricalPaths: publicSonarrHistoricalPaths(acceptedCleanup) }
              : {}),
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
    if (
      body.radarrMode !== undefined &&
      (kind !== 'movie_version' || !['coordinate', 'none'].includes(String(body.radarrMode)))
    ) {
      return c.json({ error: 'radarrMode must be coordinate or none for movie versions' }, 400);
    }
    const radarrMode = kind === 'movie_version'
      ? body.radarrMode === 'none' ? 'none' as const : 'coordinate' as const
      : null;
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
    if (
      body.allowRadarrRetainedPathManagement !== undefined &&
      typeof body.allowRadarrRetainedPathManagement !== 'boolean'
    ) {
      return c.json({ error: 'allowRadarrRetainedPathManagement must be boolean' }, 400);
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
    const allowRadarrRetainedPathManagement = body.allowRadarrRetainedPathManagement === true;
    const allowRadarrMovieRemoval = body.allowRadarrMovieRemoval === true;
    if (allowRadarrRetainedPathManagement && allowRadarrMovieRemoval) {
      return c.json({ error: 'choose one Radarr fallback action' }, 400);
    }
    if (body.unmonitorFromArr === true) {
      return c.json({ error: 'unmonitorFromArr is no longer supported for media versions' }, 400);
    }
    if (
      radarrMode === 'none' &&
      (cleanupMediaIds.size > 0 || requestedPlanFingerprint !== null ||
        allowRadarrRetainedPathManagement || allowRadarrMovieRemoval)
    ) {
      return c.json({ error: 'Plex-only deletion cannot include Radarr coordination' }, 400);
    }
    if ([...cleanupMediaIds].some((id) => !mediaIds.includes(id))) {
      return c.json({ error: 'invalid deletion destinations' }, 400);
    }
    const payload = {
      path,
      mediaIds,
      cleanupMediaIds: [...cleanupMediaIds].sort((a, b) => a - b),
      ...(radarrMode ? { radarrMode } : {}),
      ...(requestedPlanFingerprint ? { planFingerprint: requestedPlanFingerprint } : {}),
      ...(allowRadarrRetainedPathManagement ? { allowRadarrRetainedPathManagement: true } : {}),
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
              `SELECT v.library_key, i.title, v.file_size FROM item_media_versions v
               JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.item_rating_key
               WHERE v.server_id = ? AND v.item_rating_key = ? AND v.media_id = ?
                 AND NOT EXISTS (SELECT 1 FROM ignored_content ignored
                   WHERE ignored.server_id = i.server_id AND ignored.rating_key = i.rating_key)`,
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
            `SELECT v.library_key, i.title, v.episode_title, v.file_size
             FROM episode_media_versions v
             JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.show_rating_key
             WHERE v.server_id = ? AND v.episode_rating_key = ? AND v.media_id = ?
               AND NOT EXISTS (SELECT 1 FROM ignored_content ignored
                 WHERE ignored.server_id = i.server_id AND ignored.rating_key = i.rating_key)`,
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
    const episodeCleanups = new Map<number, ReturnType<typeof persistResolvedCleanupIdentity>>();
    const episodeHistoricalPaths = new Map<
      number,
      ReturnType<typeof publicSonarrHistoricalPaths>
    >();
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
      const pathOverride = acceptedPlan.preview.radarrPathOverride;
      const selectedPathDecision = allowRadarrRetainedPathManagement ? pathOverride : pathPreview;
      if (radarrMode === 'coordinate') {
        if (allowRadarrRetainedPathManagement) {
          if (
            pathOverride?.mode !== 'adopt_path_with_consent' ||
            !pathOverride.planFingerprint ||
            requestedPlanFingerprint !== pathOverride.planFingerprint
          ) {
            return c.json(
              {
                error: 'the Radarr retained-folder override changed; preview the deletion again',
              },
              409,
            );
          }
        }
        const outsideMode = pathPreview.mode === 'adopt_safe_path';
        if (allowRadarrRetainedPathManagement) {
          // The exact override fingerprint was accepted above. Execution revalidates
          // the path boundary, physical identity, Radarr behavior, and active jobs.
        } else if (outsideMode) {
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
          pathPreview.mode !== 'remove_from_radarr' &&
          !allowRadarrRetainedPathManagement
        ) {
          return c.json(
            {
              error: acceptedPlan.preview.arrReassignReason ??
                'Radarr cannot safely adopt the retained Plex version',
            },
            409,
          );
        }
        const retainedMediaId = selectedPathDecision?.retainedMediaId;
        if (
          retainedMediaId !== undefined &&
          selectedPathDecision?.mode !== 'remove_from_radarr'
        ) {
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
              ...(entry.radarrPathPlan
                ? {
                  radarrPathPlan: allowRadarrRetainedPathManagement
                    ? { ...entry.radarrPathPlan, userAuthorizedPathManagement: true }
                    : entry.radarrPathPlan,
                }
                : {}),
            } satisfies PersistedArrReassignment;
          });
          if (
            allowRadarrRetainedPathManagement &&
            (acceptedReassignments.length !== 1 ||
              acceptedReassignments[0]?.radarrPathPlan?.mode !== 'adopt_path_with_consent' ||
              acceptedReassignments[0].radarrPathPlan.userAuthorizedPathManagement !== true)
          ) {
            return c.json(
              { error: 'the authorized Radarr retained-folder override is incomplete' },
              409,
            );
          }
        }
      }
    } else {
      if (allowRadarrMovieRemoval || allowRadarrRetainedPathManagement) {
        return c.json({ error: 'Radarr path adoption is unavailable for Sonarr episodes' }, 400);
      }
      const item = enriched[0]!;
      const [liveVersions, arrTargets, downloadTargets] = await Promise.all([
        activeServer.client.mediaVersionPathPreviews(ratingKey),
        getArrDeleteTargets(serverId, libraryKey),
        getDownloadClientTargets(serverId),
      ]);
      const planInput = {
        mediaType: 'episode' as const,
        item,
        selectedMediaIds: new Set(mediaIds),
        liveVersions,
        arrTargets,
        cleanupConfigured: downloadTargets.length > 0,
        allowPartialCoverage: true,
        allowEpisodeDownloadCleanup: true,
        episodeIdentity: {
          seasonNumber: item.seasonIndex!,
          episodeNumber: item.episodeIndex!,
        },
      };
      const ownershipPlan = await buildVersionDeletionPlan({
        ...planInput,
        resolvedCleanup: null,
      });
      const managedByMedia = new Map<number, Set<number>>();
      const managedPathsByMedia = new Map<number, Set<string>>();
      for (const ownership of ownershipPlan.arrOwnerships) {
        if (
          ownership.managedMediaId === null || ownership.managedFileId === null ||
          !mediaIds.includes(ownership.managedMediaId)
        ) continue;
        const ids = managedByMedia.get(ownership.managedMediaId) ?? new Set<number>();
        ids.add(ownership.managedFileId);
        managedByMedia.set(ownership.managedMediaId, ids);
        if (ownership.managedPath !== null) {
          const paths = managedPathsByMedia.get(ownership.managedMediaId) ?? new Set<string>();
          paths.add(ownership.managedPath);
          managedPathsByMedia.set(ownership.managedMediaId, paths);
        }
      }
      let acceptedCleanup: ResolvedCleanupItem | null = null;
      if (managedByMedia.size > 0) {
        const raw = await resolveDownloadCleanup(
          item.showRatingKey!,
          {
            title: item.showTitle ?? item.title,
            type: 'show',
            tmdbId: null,
            tvdbId: item.tvdbId,
          },
          arrTargets,
          downloadTargets,
        );
        const allManagedIds = new Set([...managedByMedia.values()].flatMap((ids) => [...ids]));
        const selectedPaths = new Set(
          liveVersions.flatMap((version) =>
            cleanupMediaIds.has(version.mediaId)
              ? version.paths.flatMap((path) => {
                const normalized = normalizeRemoteAbsolute(path)?.comparison;
                return normalized ? [normalized] : [];
              })
              : []
          ),
        );
        const qbitScoped = selectVersionDownloadCleanup(raw, selectedPaths, true);
        const allManagedPaths = new Set(
          [...managedPathsByMedia.values()].flatMap((paths) => [...paths]),
        );
        acceptedCleanup = await bindSonarrPathOwnership(
          scopeSonarrReclamation(
            {
              ...raw,
              downloadJobs: qbitScoped?.downloadJobs ?? [],
              sources: qbitScoped?.sources ?? raw.sources,
            },
            allManagedIds,
            allManagedPaths,
          ),
          downloadTargets,
          [...managedByMedia.keys()].some((mediaId) => cleanupMediaIds.has(mediaId)),
        );
        if (acceptedCleanup.status !== 'resolved') {
          return c.json({
            error: acceptedCleanup.reason ?? 'qBittorrent cleanup could not be verified',
          }, 409);
        }
        for (const [mediaId, managedIds] of managedByMedia) {
          const scoped = scopeSonarrReclamation(
            acceptedCleanup,
            managedIds,
            managedPathsByMedia.get(mediaId),
          );
          episodeHistoricalPaths.set(mediaId, publicSonarrHistoricalPaths(scoped));
          if (scoped.downloadJobs.length > 0 || scoped.sonarrReclamation) {
            episodeCleanups.set(mediaId, persistResolvedCleanupIdentity(scoped));
          }
        }
      } else if (requestedPlanFingerprint !== null) {
        return c.json({ error: 'the accepted Sonarr coordination decision changed' }, 409);
      }
      acceptedPlan = await buildVersionDeletionPlan({
        ...planInput,
        resolvedCleanup: acceptedCleanup,
      });
      if (
        managedByMedia.size > 0 &&
        requestedPlanFingerprint !== await episodeVersionSonarrPlanFingerprint(acceptedPlan)
      ) {
        return c.json(
          { error: 'the accepted Sonarr plan changed; review the deletion again' },
          409,
        );
      }
    }
    const targets: NewDeletionTarget[] = enriched.map((target) => {
      const reassignment = acceptedReassignments.find(
        (entry) =>
          acceptedPlan?.arrManagedMediaIds.includes(target.mediaId) && entry.managedFileId !== null,
      );
      const removalFallback = radarrMode === 'coordinate' &&
          !allowRadarrRetainedPathManagement &&
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
          ...(radarrMode === 'none' ? { skipArrCoordination: true } : {}),
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
          ...(kind === 'episode_version' && acceptedPlan
            ? {
              arrReassignmentMappings: acceptedPlan.arrMappingIdentities,
              arrOwnerships: acceptedPlan.arrOwnerships,
              ...(episodeCleanups.has(target.mediaId)
                ? { seasonDownloadCleanup: episodeCleanups.get(target.mediaId) }
                : {}),
              ...(episodeHistoricalPaths.has(target.mediaId)
                ? { sonarrHistoricalPaths: episodeHistoricalPaths.get(target.mediaId) }
                : {}),
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
