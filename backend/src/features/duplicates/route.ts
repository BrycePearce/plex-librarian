import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { episodeMediaVersions, itemMediaVersions, items } from '../../db/schema.ts';
import { episodeVersionsByEpisode, itemByRatingKey, mediaVersionsByItem } from '../../db/scope.ts';
import { createPlexClient } from '../../integrations/plex/index.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { resolveDownloadCleanup } from '../mediaDeletion/cleanup.ts';
import {
  loadAttemptedArrInstancesByItem,
  loadAttemptedDownloadJobKeysByItem,
  loadAttemptedOrphanFilesByItem,
} from '../mediaDeletion/planning.ts';
import { downloadClientsConfigured, getDownloadClientTargets } from '../mediaDeletion/targets.ts';
import { buildVersionDeletionPlan } from '../mediaDeletion/versionPlanning.ts';
import {
  assertRelocationWorkflowClear,
  RelocationConflictError,
} from '../deletionOperations/relocation/relocation.ts';
import listRoute from './listRoute.ts';
import { mediaVersionFromRow } from './mediaVersion.ts';
import smartCleanupRoute from './smartCleanupRoute.ts';
import { technicalDetailUpdate } from './technicalDetails.ts';
import { findRadarrMovieReservation } from '../deletionOperations/service.ts';
import type {
  MediaVersionsRefreshResponse,
  VersionDeletionPreviewResponse,
} from '@plex-librarian/shared/types.ts';

function parseMediaIds(body: unknown): number[] | null {
  if (!body || typeof body !== 'object' || !('mediaIds' in body)) return null;
  const mediaIds = (body as { mediaIds?: unknown }).mediaIds;
  if (
    !Array.isArray(mediaIds) || mediaIds.length === 0 || mediaIds.length > 50 ||
    !mediaIds.every((value): value is number => Number.isSafeInteger(value) && value >= 0)
  ) return null;
  return [...new Set(mediaIds)];
}

const router = new Hono<{ Variables: ActiveServerVariables }>();
// Smart cleanup performs its durable warning-overlap check before resolving Plex.
// Register it ahead of the general active-server middleware so a warned target can
// still be redirected to its original operation after sync prunes the projection.
router.route('/', smartCleanupRoute);
router.use('*', withActiveServerId);
router.route('/', listRoute);

router.post('/movies/:ratingKey/media/deletion-preview', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const body = await c.req.json().catch(() => null);
  const mediaIds = parseMediaIds(body);
  if (!mediaIds) return c.json({ error: 'mediaIds must contain between 1 and 50 integers' }, 400);
  if (
    body && typeof body === 'object' &&
    (body as { inspectDownloadCleanup?: unknown }).inspectDownloadCleanup !== undefined &&
    typeof (body as { inspectDownloadCleanup?: unknown }).inspectDownloadCleanup !== 'boolean'
  ) return c.json({ error: 'inspectDownloadCleanup must be boolean' }, 400);
  const inspectDownloadCleanup =
    (body as { inspectDownloadCleanup?: boolean } | null)?.inspectDownloadCleanup === true;
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'movie not found' }, 404);

  const [[item], versions] = await Promise.all([
    db.select({
      ratingKey: items.ratingKey,
      title: items.title,
      type: items.type,
      tmdbId: items.tmdbId,
      tvdbId: items.tvdbId,
      libraryKey: items.libraryKey,
    }).from(items).where(itemByRatingKey(serverId, ratingKey)).limit(1),
    db.select().from(itemMediaVersions).where(mediaVersionsByItem(serverId, ratingKey)),
  ]);
  if (!item || item.type !== 'movie') return c.json({ error: 'movie not found' }, 404);
  try {
    assertRelocationWorkflowClear(serverId, item.libraryKey, [ratingKey]);
  } catch (error) {
    if (error instanceof RelocationConflictError) return c.json({ error: error.message }, 409);
    throw error;
  }
  if (mediaIds.some((mediaId) => !versions.some((version) => version.mediaId === mediaId))) {
    return c.json({ error: 'one or more media versions were not found' }, 404);
  }

  try {
    const client = await createPlexClient();
    const [
      liveVersions,
      arrTargets,
      cleanupConfigured,
      downloadTargets,
      attemptedKeys,
      attemptedOrphans,
    ] = await Promise.all([
      client.mediaVersionPathPreviews(ratingKey),
      getArrDeleteTargets(serverId, item.libraryKey),
      downloadClientsConfigured(serverId),
      inspectDownloadCleanup ? getDownloadClientTargets(serverId) : Promise.resolve([]),
      inspectDownloadCleanup
        ? loadAttemptedDownloadJobKeysByItem(serverId, [ratingKey])
        : Promise.resolve(new Map()),
      inspectDownloadCleanup
        ? loadAttemptedOrphanFilesByItem(serverId, [ratingKey])
        : Promise.resolve(new Map()),
    ]);
    const cleanup = inspectDownloadCleanup
      ? await resolveDownloadCleanup(
        ratingKey,
        item,
        arrTargets,
        downloadTargets,
        attemptedKeys.get(ratingKey),
        attemptedOrphans.get(ratingKey),
      )
      : null;
    const attemptedArrInstances = await loadAttemptedArrInstancesByItem(
      serverId,
      [item],
      arrTargets.map((target) => target.instanceId),
    );
    const plan = await buildVersionDeletionPlan({
      mediaType: 'movie',
      item,
      selectedMediaIds: new Set(mediaIds),
      liveVersions,
      arrTargets,
      resolvedCleanup: cleanup,
      cleanupConfigured,
      attemptedArrInstanceIds: attemptedArrInstances.get(ratingKey),
      allowPartialCoverage: true,
      serverId,
      libraryKey: item.libraryKey,
      plexClient: client,
      versionRanks: versions,
    });
    const blockingOperationId = findRadarrMovieReservation(
      serverId,
      [
        ...plan.eligibleArrReassignments.map((entry) => ({
          arrInstanceId: entry.target.instanceId,
          movieId: entry.recordId,
        })),
        ...(plan.radarrRemovalFallback
          ? [{
            arrInstanceId: plan.radarrRemovalFallback.arrInstanceId,
            movieId: plan.radarrRemovalFallback.movieId,
          }]
          : []),
      ],
    );
    if (blockingOperationId) {
      return c.json({
        error: 'another operation already reserves this Radarr movie',
        operationId: blockingOperationId,
      }, 409);
    }
    return c.json(plan.preview satisfies VersionDeletionPreviewResponse);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not build deletion preview',
    }, 502);
  }
});

router.post('/episodes/:ratingKey/media/deletion-preview', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const mediaIds = parseMediaIds(await c.req.json().catch(() => null));
  if (!mediaIds) return c.json({ error: 'mediaIds must contain between 1 and 50 integers' }, 400);
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'episode not found' }, 404);

  const versions = await db.select().from(episodeMediaVersions)
    .where(episodeVersionsByEpisode(serverId, ratingKey));
  if (
    versions.length === 0 ||
    mediaIds.some((mediaId) => !versions.some((version) => version.mediaId === mediaId))
  ) return c.json({ error: 'one or more media versions were not found' }, 404);
  const target = versions[0]!;
  try {
    assertRelocationWorkflowClear(serverId, target.libraryKey, [target.showRatingKey]);
  } catch (error) {
    if (error instanceof RelocationConflictError) return c.json({ error: error.message }, 409);
    throw error;
  }
  const [show] = await db.select({
    title: items.title,
    type: items.type,
    tmdbId: items.tmdbId,
    tvdbId: items.tvdbId,
  }).from(items).where(itemByRatingKey(serverId, target.showRatingKey)).limit(1);
  if (!show) return c.json({ error: 'show not found' }, 404);

  try {
    const client = await createPlexClient();
    const [liveVersions, arrTargets, cleanupConfigured] = await Promise.all([
      client.mediaVersionPathPreviews(ratingKey),
      getArrDeleteTargets(serverId, target.libraryKey),
      downloadClientsConfigured(serverId),
    ]);
    const plan = await buildVersionDeletionPlan({
      mediaType: 'episode',
      item: show,
      selectedMediaIds: new Set(mediaIds),
      liveVersions,
      arrTargets,
      resolvedCleanup: null,
      cleanupConfigured,
      allowPartialCoverage: true,
      episodeIdentity: {
        seasonNumber: target.seasonIndex,
        episodeNumber: target.episodeIndex,
      },
    });
    return c.json(plan.preview satisfies VersionDeletionPreviewResponse);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not build deletion preview',
    }, 502);
  }
});

// On-demand only — never called during sync. An individual review refreshes its one
// group here; Quick Cleanup applies the same enrichment to a separately bounded set of
// its largest scanned groups. Neither path adds per-item requests to full-library sync.
router.post('/movies/:ratingKey/media/technical-refresh', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'movie not found' }, 404);

  const versions = await db.select().from(itemMediaVersions)
    .where(mediaVersionsByItem(serverId, ratingKey));
  if (versions.length === 0) return c.json({ error: 'movie not found' }, 404);

  try {
    const client = await createPlexClient();
    const details = await client.mediaVersionTechnicalDetails(ratingKey);
    await Promise.all(
      versions
        .filter((version) => details.has(version.mediaId))
        .map((version) =>
          db.update(itemMediaVersions)
            .set(technicalDetailUpdate(details.get(version.mediaId)!))
            .where(
              and(
                eq(itemMediaVersions.serverId, serverId),
                eq(itemMediaVersions.mediaId, version.mediaId),
              ),
            )
        ),
    );
    const refreshed = await db.select().from(itemMediaVersions)
      .where(mediaVersionsByItem(serverId, ratingKey));
    return c.json(
      { versions: refreshed.map(mediaVersionFromRow) } satisfies MediaVersionsRefreshResponse,
    );
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not refresh technical detail',
    }, 502);
  }
});

router.post('/episodes/:ratingKey/media/technical-refresh', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'episode not found' }, 404);

  const versions = await db.select().from(episodeMediaVersions)
    .where(episodeVersionsByEpisode(serverId, ratingKey));
  if (versions.length === 0) return c.json({ error: 'episode not found' }, 404);

  try {
    const client = await createPlexClient();
    const details = await client.mediaVersionTechnicalDetails(ratingKey);
    await Promise.all(
      versions
        .filter((version) => details.has(version.mediaId))
        .map((version) =>
          db.update(episodeMediaVersions)
            .set(technicalDetailUpdate(details.get(version.mediaId)!))
            .where(
              and(
                eq(episodeMediaVersions.serverId, serverId),
                eq(episodeMediaVersions.mediaId, version.mediaId),
              ),
            )
        ),
    );
    const refreshed = await db.select().from(episodeMediaVersions)
      .where(episodeVersionsByEpisode(serverId, ratingKey));
    return c.json(
      { versions: refreshed.map(mediaVersionFromRow) } satisfies MediaVersionsRefreshResponse,
    );
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not refresh technical detail',
    }, 502);
  }
});

export default router;
