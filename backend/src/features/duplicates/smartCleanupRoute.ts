import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import {
  episodeMediaVersions,
  itemMediaVersions,
  items,
  mediaVersionReservations,
} from '../../db/schema.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import type { PlexMediaTechnicalDetails } from '../../integrations/plex/types.ts';
import type { ActiveServerVariables } from '../../middleware/activeServer.ts';
import {
  DeletionConflictError,
  enqueueDeletionOperations,
  type NewDeletionOperation,
  type NewDeletionTarget,
  repeatedDeletionOperationBatch,
} from '../deletionOperations/service.ts';
import { mediaRatingKeyIsPlaying } from '../mediaDeletion/activePlayback.ts';
import {
  buildSmartDuplicateAnalysis,
  isValidSmartCleanupSelection,
  SMART_CLEANUP_DELETE_IDS_LIMIT,
  SMART_CLEANUP_GROUP_LIMIT,
} from './smartAnalysis.ts';
import type {
  MediaVersion,
  SmartDuplicateCandidate,
  SmartDuplicateCleanupResponse,
} from '@plex-librarian/shared/types.ts';

function classificationTechnicalSnapshot(version: MediaVersion): PlexMediaTechnicalDetails {
  return {
    width: version.width,
    height: version.height,
    duration: version.duration,
    videoProfile: version.videoProfile,
    videoBitDepth: version.videoBitDepth,
    videoDynamicRange: version.videoDynamicRange,
    videoFrameRate: version.videoFrameRate,
    videoScanType: version.videoScanType,
    audioCodec: version.audioCodec,
    audioChannels: version.audioChannels,
    audioProfile: version.audioProfile,
    audioStreams: version.audioStreams,
    subtitleStreams: version.subtitleStreams,
    streamDetailsAvailable: version.streamDetailsAvailable,
  };
}

const router = new Hono<{ Variables: ActiveServerVariables }>();

router.post('/smart-analysis', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const movies = body.movies !== false;
  const tv = body.tv !== false;
  if (!movies && !tv) return c.json({ error: 'select movies, TV, or both' }, 400);
  const serverId = c.get('activeServerId');
  if (serverId === null) {
    return c.json({ analyzedGroups: 0, protectedGroups: 0, candidates: [] });
  }
  try {
    const activeServer = await resolveActiveServer();
    if (activeServer.serverId !== serverId) {
      return c.json({ error: 'the active Plex server changed during analysis' }, 409);
    }
    const [analysis, sessions, reservations] = await Promise.all([
      buildSmartDuplicateAnalysis(serverId, { movies, tv }),
      activeServer.client.activeSessions(),
      db.select({
        mediaKind: mediaVersionReservations.mediaKind,
        ratingKey: mediaVersionReservations.ratingKey,
      }).from(mediaVersionReservations).where(eq(mediaVersionReservations.serverId, serverId)),
    ]);
    const reservedGroups = new Set(
      reservations.map((reservation) => `${reservation.mediaKind}:${reservation.ratingKey}`),
    );
    const unreservedCandidates = analysis.candidates.filter((candidate) =>
      !reservedGroups.has(
        `${candidate.mediaType === 'movie' ? 'movie' : 'episode'}:${candidate.ratingKey}`,
      )
    );
    const candidates = unreservedCandidates.filter((candidate) =>
      !mediaRatingKeyIsPlaying(candidate.ratingKey, sessions)
    );
    const reservedCount = analysis.candidates.length - unreservedCandidates.length;
    const activeCount = unreservedCandidates.length - candidates.length;
    return c.json({
      ...analysis,
      protectedGroups: analysis.protectedGroups + reservedCount + activeCount,
      candidates,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not analyze duplicate versions',
    }, 502);
  }
});

router.post('/smart-cleanup', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const clientRequestId = typeof body.clientRequestId === 'string' ? body.clientRequestId : '';
  const selections = Array.isArray(body.selections) ? body.selections : [];
  const includeNearIdentical = body.includeNearIdentical === true;
  if (!/^[A-Za-z0-9._:-]{1,124}$/.test(clientRequestId)) {
    return c.json(
      { error: 'clientRequestId must be a non-empty string of at most 124 characters' },
      400,
    );
  }
  if (selections.length === 0 || selections.length > SMART_CLEANUP_GROUP_LIMIT) {
    return c.json(
      { error: `selections must contain between 1 and ${SMART_CLEANUP_GROUP_LIMIT} groups` },
      400,
    );
  }
  const parsed = selections.map((selection) => {
    if (!selection || typeof selection !== 'object') return null;
    const value = selection as Record<string, unknown>;
    if (
      (value.mediaType !== 'movie' && value.mediaType !== 'episode') ||
      typeof value.ratingKey !== 'string' ||
      !Array.isArray(value.deleteMediaIds) ||
      value.deleteMediaIds.length === 0 ||
      value.deleteMediaIds.length > SMART_CLEANUP_DELETE_IDS_LIMIT ||
      !value.deleteMediaIds.every((id) => Number.isSafeInteger(id) && Number(id) >= 0)
    ) return null;
    return {
      mediaType: value.mediaType,
      ratingKey: value.ratingKey,
      deleteMediaIds: [...new Set(value.deleteMediaIds as number[])].sort((a, b) => a - b),
    };
  });
  if (parsed.some((selection) => selection === null)) {
    return c.json({ error: 'one or more cleanup selections are invalid' }, 400);
  }

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 404);
  const normalizedSelections = parsed as Array<{
    mediaType: 'movie' | 'episode';
    ratingKey: string;
    deleteMediaIds: number[];
  }>;
  const batchPayload = {
    path: '/api/duplicates/smart-cleanup',
    selections: normalizedSelections,
    includeNearIdentical,
  };
  try {
    const repeated = await repeatedDeletionOperationBatch(
      serverId,
      clientRequestId,
      batchPayload,
    );
    if (repeated) {
      return c.json(repeated satisfies SmartDuplicateCleanupResponse, 202);
    }
  } catch (error) {
    if (error instanceof DeletionConflictError) {
      return c.json({ error: error.message }, error.status as 400 | 404 | 409);
    }
    throw error;
  }

  const analysis = await buildSmartDuplicateAnalysis(serverId, { movies: true, tv: true });
  const allowed = new Map(
    analysis.candidates
      .filter((candidate) =>
        candidate.confidence === 'obvious' ||
        (includeNearIdentical && candidate.confidence === 'near-identical')
      )
      .map((candidate) => [`${candidate.mediaType}:${candidate.ratingKey}`, candidate]),
  );
  const selectedKeys = new Set<string>();
  const selectedCandidates: SmartDuplicateCandidate[] = [];
  for (const selection of normalizedSelections) {
    const key = `${selection.mediaType}:${selection.ratingKey}`;
    const candidate = allowed.get(key);
    if (
      !candidate ||
      selectedKeys.has(key) ||
      !isValidSmartCleanupSelection(candidate, selection.deleteMediaIds)
    ) {
      return c.json(
        { error: 'the cleanup plan changed; analyze duplicates again before deleting' },
        409,
      );
    }
    selectedKeys.add(key);
    selectedCandidates.push({
      ...candidate,
      deleteMediaIds: selection.deleteMediaIds,
    });
  }

  const machineIdentifier = withTransaction((client) =>
    client.prepare('SELECT machine_identifier FROM servers WHERE id = ?').value<[string]>(
      serverId,
    )?.[0] ?? null
  );
  if (!machineIdentifier) return c.json({ error: 'Plex server identity is unavailable' }, 409);
  const activeServer = await resolveActiveServer();
  if (activeServer.serverId !== serverId) {
    return c.json({ error: 'the active Plex server changed during cleanup' }, 409);
  }
  const sessions = await activeServer.client.activeSessions();
  if (
    selectedCandidates.some((candidate) => mediaRatingKeyIsPlaying(candidate.ratingKey, sessions))
  ) {
    return c.json(
      {
        error: 'a selected version started playing; analyze duplicates again after playback stops',
      },
      409,
    );
  }
  const serverUrl = activeServer.client.serverUrl;
  const movieKeys = selectedCandidates.filter((candidate) => candidate.mediaType === 'movie')
    .map((candidate) => candidate.ratingKey);
  const episodeKeys = selectedCandidates.filter((candidate) => candidate.mediaType === 'episode')
    .map((candidate) => candidate.ratingKey);
  const [movieRows, episodeRows] = await Promise.all([
    movieKeys.length === 0 ? [] : db.select().from(itemMediaVersions).where(and(
      eq(itemMediaVersions.serverId, serverId),
      inArray(itemMediaVersions.itemRatingKey, movieKeys),
    )),
    episodeKeys.length === 0 ? [] : db.select().from(episodeMediaVersions).where(and(
      eq(episodeMediaVersions.serverId, serverId),
      inArray(episodeMediaVersions.episodeRatingKey, episodeKeys),
    )),
  ]);
  const movieItems = movieKeys.length === 0 ? [] : await db.select({
    ratingKey: items.ratingKey,
    tmdbId: items.tmdbId,
    tvdbId: items.tvdbId,
  }).from(items).where(and(
    eq(items.serverId, serverId),
    inArray(items.ratingKey, movieKeys),
  ));
  const showKeys = [...new Set(episodeRows.map((row) => row.showRatingKey))];
  const showItems = showKeys.length === 0 ? [] : await db.select({
    ratingKey: items.ratingKey,
    tmdbId: items.tmdbId,
    tvdbId: items.tvdbId,
  }).from(items).where(and(
    eq(items.serverId, serverId),
    inArray(items.ratingKey, showKeys),
  ));
  const movieItemByKey = new Map(movieItems.map((item) => [item.ratingKey, item]));
  const showItemByKey = new Map(showItems.map((item) => [item.ratingKey, item]));
  const targets: NewDeletionTarget[] = [];
  for (const candidate of selectedCandidates) {
    const selectedIds = new Set(candidate.deleteMediaIds);
    const retainedVersion = candidate.versions.find((version) => !selectedIds.has(version.mediaId));
    if (!retainedVersion) {
      return c.json(
        { error: 'the cleanup plan changed; analyze duplicates again before deleting' },
        409,
      );
    }
    const rows = candidate.mediaType === 'movie'
      ? movieRows.filter((row) =>
        row.itemRatingKey === candidate.ratingKey && selectedIds.has(row.mediaId)
      )
      : episodeRows.filter((row) =>
        row.episodeRatingKey === candidate.ratingKey && selectedIds.has(row.mediaId)
      );
    if (rows.length !== candidate.deleteMediaIds.length) {
      return c.json(
        { error: 'the cleanup plan changed; analyze duplicates again before deleting' },
        409,
      );
    }
    for (const row of rows) {
      const sourceVersion = candidate.versions.find((version) => version.mediaId === row.mediaId);
      if (!sourceVersion) {
        return c.json(
          { error: 'the cleanup plan changed; analyze duplicates again before deleting' },
          409,
        );
      }
      const episodeRow = candidate.mediaType === 'episode'
        ? row as typeof episodeMediaVersions.$inferSelect
        : null;
      const parentItem = candidate.mediaType === 'movie'
        ? movieItemByKey.get(candidate.ratingKey)
        : showItemByKey.get(episodeRow!.showRatingKey);
      targets.push({
        kind: candidate.mediaType === 'movie' ? 'movie_version' : 'episode_version',
        key: `${candidate.ratingKey}:${row.mediaId}`,
        title: candidate.context ? `${candidate.title} — ${candidate.context}` : candidate.title,
        logicalSize: row.fileSize,
        snapshot: {
          machineIdentifier,
          serverUrl,
          libraryKey: candidate.libraryKey,
          ratingKey: candidate.ratingKey,
          mediaId: row.mediaId,
          title: candidate.title,
          type: candidate.mediaType === 'movie' ? 'movie' : 'episode',
          tmdbId: candidate.mediaType === 'movie' ? parentItem?.tmdbId ?? null : null,
          tvdbId: parentItem?.tvdbId ?? null,
          fileSize: row.fileSize,
          videoResolution: row.videoResolution,
          bitrate: row.bitrate,
          videoCodec: row.videoCodec,
          container: row.container,
          showTitle: candidate.mediaType === 'episode' ? candidate.title : null,
          episodeTitle: episodeRow?.episodeTitle ?? null,
          showRatingKey: episodeRow?.showRatingKey ?? null,
          seasonRatingKey: episodeRow?.seasonRatingKey ?? null,
          seasonIndex: episodeRow?.seasonIndex ?? null,
          episodeIndex: episodeRow?.episodeIndex ?? null,
          cleanupDownloads: false,
          selectedMediaIds: [row.mediaId],
          operationMediaIds: candidate.deleteMediaIds,
          classificationTechnicalDetails: classificationTechnicalSnapshot(sourceVersion),
          expectedRetainedVersion: {
            mediaId: retainedVersion.mediaId,
            fileSize: retainedVersion.fileSize,
            videoResolution: retainedVersion.videoResolution,
            height: retainedVersion.height,
            bitrate: retainedVersion.bitrate,
            videoCodec: retainedVersion.videoCodec,
            container: retainedVersion.container,
            classificationTechnicalDetails: classificationTechnicalSnapshot(retainedVersion),
          },
          height: row.height,
        },
        reservation: {
          mediaKind: candidate.mediaType === 'movie' ? 'movie' : 'episode',
          mediaId: row.mediaId,
          ratingKey: candidate.ratingKey,
        },
      });
    }
  }

  const grouped = new Map<string, NewDeletionTarget[]>();
  for (const target of targets) {
    const libraryKey = String(target.snapshot.libraryKey);
    const key = `${target.kind}:${libraryKey}`;
    const group = grouped.get(key) ?? [];
    group.push(target);
    grouped.set(key, group);
  }
  try {
    let index = 0;
    const operations: NewDeletionOperation[] = [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, group]) => {
        const [kind, ...libraryParts] = key.split(':');
        const libraryKey = libraryParts.join(':');
        return {
          clientRequestId: `${clientRequestId}:${index++}`,
          serverId,
          libraryKey,
          kind: kind as 'movie_version' | 'episode_version',
          payload: batchPayload,
          targets: group,
        };
      });
    const results = await enqueueDeletionOperations(operations);
    return c.json(
      {
        operationIds: results.map((result) => result.operationId),
        targetCount: targets.length,
      } satisfies SmartDuplicateCleanupResponse,
      202,
    );
  } catch (error) {
    if (error instanceof DeletionConflictError) {
      return c.json({ error: error.message }, error.status as 400 | 404 | 409);
    }
    throw error;
  }
});

export default router;
