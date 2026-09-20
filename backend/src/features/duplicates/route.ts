import { Hono } from 'hono';

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { episodeMediaVersions, itemMediaVersions } from '../../db/schema.ts';
import {
  contentIsNotIgnored,
  episodeVersionsByEpisode,
  mediaVersionsByItem,
} from '../../db/scope.ts';
import { createPlexClient } from '../../integrations/plex/index.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';

import listRoute from './listRoute.ts';
import { mediaVersionFromRow } from './mediaVersion.ts';
import smartAnalysisRoute from './smartAnalysisRoute.ts';
import seasonAnalysisRoute from './seasonAnalysisRoute.ts';

import { technicalDetailUpdate } from './technicalDetails.ts';

import type { MediaVersionsRefreshResponse } from '@plex-librarian/shared/types.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.route('/', smartAnalysisRoute);

router.use('*', withActiveServerId);
router.route('/', listRoute);
router.route('/', seasonAnalysisRoute);

router.post('/movies/:ratingKey/media/technical-refresh', async (c) => {
  const ratingKey = c.req.param('ratingKey');
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'movie not found' }, 404);

  const versions = await db.select().from(itemMediaVersions)
    .where(and(
      mediaVersionsByItem(serverId, ratingKey),
      contentIsNotIgnored(serverId, itemMediaVersions.itemRatingKey),
    ));
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
    .where(and(
      episodeVersionsByEpisode(serverId, ratingKey),
      contentIsNotIgnored(serverId, episodeMediaVersions.showRatingKey),
    ));
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
