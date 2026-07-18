import { Hono } from 'hono';
import { db } from '../../db/index.ts';
import { episodeMediaVersions, itemMediaVersions, items } from '../../db/schema.ts';
import { episodeVersionsByEpisode, itemByRatingKey, mediaVersionsByItem } from '../../db/scope.ts';
import { createPlexClient } from '../../integrations/plex/index.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { getDownloadClientTargets } from '../mediaDeletion/targets.ts';
import { resolveDownloadCleanup } from '../mediaDeletion/cleanup.ts';
import { buildVersionDeletionPlan } from '../mediaDeletion/versionPlanning.ts';
import {
  loadAttemptedArrInstancesByItem,
  loadAttemptedDownloadJobKeysByItem,
  loadAttemptedOrphanFilesByItem,
} from '../mediaDeletion/planning.ts';
import listRoute from './listRoute.ts';
import type { VersionDeletionPreviewResponse } from '@plex-librarian/shared/types.ts';

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
router.use('*', withActiveServerId);
router.route('/', listRoute);

router.post('/movies/:ratingKey/media/deletion-preview', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const mediaIds = parseMediaIds(await c.req.json().catch(() => null));
  if (!mediaIds) return c.json({ error: 'mediaIds must contain between 1 and 50 integers' }, 400);
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
  if (mediaIds.some((mediaId) => !versions.some((version) => version.mediaId === mediaId))) {
    return c.json({ error: 'one or more media versions were not found' }, 404);
  }

  try {
    const client = await createPlexClient();
    const [liveVersions, arrTargets, downloadTargets, attemptedKeys, attemptedOrphans] =
      await Promise.all([
        client.mediaVersionPathPreviews(ratingKey),
        getArrDeleteTargets(serverId, item.libraryKey),
        getDownloadClientTargets(serverId),
        loadAttemptedDownloadJobKeysByItem(serverId, [ratingKey]),
        loadAttemptedOrphanFilesByItem(serverId, [ratingKey]),
      ]);
    const cleanup = await resolveDownloadCleanup(
      ratingKey,
      item,
      arrTargets,
      downloadTargets,
      attemptedKeys.get(ratingKey),
      attemptedOrphans.get(ratingKey),
    );
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
      cleanupConfigured: downloadTargets.length > 0,
      attemptedArrInstanceIds: attemptedArrInstances.get(ratingKey),
    });
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
  const [show] = await db.select({
    title: items.title,
    type: items.type,
    tmdbId: items.tmdbId,
    tvdbId: items.tvdbId,
  }).from(items).where(itemByRatingKey(serverId, target.showRatingKey)).limit(1);
  if (!show) return c.json({ error: 'show not found' }, 404);

  try {
    const client = await createPlexClient();
    const [liveVersions, arrTargets, downloadTargets] = await Promise.all([
      client.mediaVersionPathPreviews(ratingKey),
      getArrDeleteTargets(serverId, target.libraryKey),
      getDownloadClientTargets(serverId),
    ]);
    const plan = await buildVersionDeletionPlan({
      mediaType: 'episode',
      item: show,
      selectedMediaIds: new Set(mediaIds),
      liveVersions,
      arrTargets,
      resolvedCleanup: null,
      cleanupConfigured: downloadTargets.length > 0,
    });
    return c.json(plan.preview satisfies VersionDeletionPreviewResponse);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not build deletion preview',
    }, 502);
  }
});

export default router;
