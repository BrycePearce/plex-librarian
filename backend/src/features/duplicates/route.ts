import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { episodeMediaVersions, itemMediaVersions, items } from '../../db/schema.ts';
import { episodeVersionsByEpisode, itemByRatingKey, mediaVersionsByItem } from '../../db/scope.ts';
import { createPlexClient } from '../../integrations/plex/index.ts';
import type { PlexMediaTechnicalDetails } from '../../integrations/plex/types.ts';
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
import { mediaVersionFromRow } from './mediaVersion.ts';
import type {
  MediaVersionsRefreshResponse,
  VersionDeletionPreviewResponse,
} from '@plex-librarian/shared/types.ts';

// Shared by both technical-refresh routes below: writes fresh per-Media technical detail
// back onto the same rows sync populates, keyed by Plex's own Media id (already the
// table's primary key alongside serverId — see schema.ts) so no item/episode join is
// needed. This is a live-Plex enrichment of existing rows, not a resync: fields sync
// itself doesn't touch (fileSize, container, etc.) are left alone.
function technicalDetailUpdate(detail: PlexMediaTechnicalDetails, now: number) {
  return {
    width: detail.width,
    height: detail.height,
    duration: detail.duration,
    videoProfile: detail.videoProfile,
    videoBitDepth: detail.videoBitDepth,
    videoDynamicRange: detail.videoDynamicRange,
    videoFrameRate: detail.videoFrameRate,
    videoScanType: detail.videoScanType,
    audioCodec: detail.audioCodec,
    audioChannels: detail.audioChannels,
    audioProfile: detail.audioProfile,
    audioStreamsJson: JSON.stringify(detail.audioStreams),
    subtitleStreamsJson: JSON.stringify(detail.subtitleStreams),
    streamDetailsAvailable: detail.streamDetailsAvailable,
    updatedAt: now,
  };
}

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
      allowPartialCoverage: true,
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

// On-demand only — never called during sync. A duplicate group's comparison can land
// in "unknown" because the bulk library listing sync reads from came back with thinner
// Media/Part/Stream detail than a single-item Plex lookup provides (see
// mediaVersionTechnicalDetails() in the Plex client for why). Fetching that richer
// detail for every duplicate group at sync time would mean one extra Plex request per
// group on every sync; fetching it only when a user opens the review modal for an
// ambiguous group keeps the cost proportional to actual attention, not library size.
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
    const now = Math.floor(Date.now() / 1000);
    await Promise.all(
      versions
        .filter((version) => details.has(version.mediaId))
        .map((version) =>
          db.update(itemMediaVersions)
            .set(technicalDetailUpdate(details.get(version.mediaId)!, now))
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
    const now = Math.floor(Date.now() / 1000);
    await Promise.all(
      versions
        .filter((version) => details.has(version.mediaId))
        .map((version) =>
          db.update(episodeMediaVersions)
            .set(technicalDetailUpdate(details.get(version.mediaId)!, now))
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
