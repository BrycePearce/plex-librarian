import { ordinaryPreviews } from './ordinaryPreview.ts';
import { loadServiceRoots, serviceEndpoints } from './serviceStorage.ts';
import { Hono, type MiddlewareHandler } from 'hono';

import { and, inArray } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { items } from '../../db/schema.ts';
import { itemsByLibrary } from '../../db/scope.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import type { DownloadCleanupPreviewResponse } from '@plex-librarian/shared/types.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';

import { resolveActiveServer } from '../../integrations/plex/index.ts';

import { getDownloadClientTargets } from './targets.ts';
import {
  assertRelocationWorkflowClear,
  RelocationConflictError,
} from '../deletionOperations/relocation/relocation.ts';

type PreviewApp = { Variables: ActiveServerVariables };

export function createDownloadCleanupPreviewRouter(
  activeServerMiddleware: MiddlewareHandler<PreviewApp> = withActiveServerId,
): Hono<PreviewApp> {
  const router = new Hono<PreviewApp>();
  router.use('*', activeServerMiddleware);

  // Resolves live download jobs from retained Arr import history. This is deliberately
  // a POST: rating keys are validated as library-owned input and bulk selections do not
  // belong in a query string. It never mutates Arr, download clients, Plex, or local rows.
  router.post('/:key/items/download-cleanup-preview', async (c) => {
    const key = c.req.param('key');
    const body = await c.req.json().catch(() => null) as { ratingKeys?: unknown } | null;
    if (
      !body || !Array.isArray(body.ratingKeys) || body.ratingKeys.length === 0 ||
      body.ratingKeys.length > 200 ||
      !body.ratingKeys.every((ratingKey): ratingKey is string => typeof ratingKey === 'string')
    ) return c.json({ error: 'ratingKeys must contain between 1 and 200 strings' }, 400);

    const serverId = c.get('activeServerId');
    if (serverId === null) return c.json({ error: 'library not found' }, 404);
    try {
      assertRelocationWorkflowClear(serverId, key, body.ratingKeys);
    } catch (error) {
      if (error instanceof RelocationConflictError) return c.json({ error: error.message }, 409);
      throw error;
    }
    const ratingKeys = [...new Set(body.ratingKeys)];
    const owned = await db.select({
      ratingKey: items.ratingKey,
      title: items.title,
      type: items.type,
      tmdbId: items.tmdbId,
      tvdbId: items.tvdbId,
    }).from(items).where(and(itemsByLibrary(serverId, key), inArray(items.ratingKey, ratingKeys)));
    const [arrTargets, downloadTargets, activeServer, roots, connections] = await Promise.all([
      getArrDeleteTargets(serverId, key),
      getDownloadClientTargets(serverId),
      resolveActiveServer(),
      loadServiceRoots(serverId),
      serviceEndpoints(serverId),
    ]);
    if (activeServer.serverId !== serverId) {
      return c.json({ error: 'The active Plex server changed' }, 409);
    }
    const previews = await ordinaryPreviews(
      owned.map((item) => ({
        serverId,
        libraryKey: key,
        selection: { ...item, type: item.type as 'movie' | 'show' },
        plex: activeServer.client,
        arrTargets,
        downloadTargets,
        roots,
        connections,
      })),
    );
    for (const ratingKey of ratingKeys) {
      if (owned.some((item) => item.ratingKey === ratingKey)) continue;
      previews.push({
        ratingKey,
        plexPaths: [],
        plexPathStatus: 'unavailable' as const,
        plexPathReason: 'Item was not found in this library',
        plexPathsTruncated: false,
        status: 'unavailable' as const,
        downloadJobs: [],
        reason: 'Item was not found in this library',
        arrStatus: 'unavailable' as const,
        arrReason: 'Item was not found in this library',
        arrTargets: [],
        sources: [],
        orphanFiles: [],
        retainedPaths: [],
      });
    }
    return c.json(
      {
        downloadClientsConfigured: downloadTargets.length > 0,
        coordinatedConfigured: arrTargets.length > 0,
        items: previews,
      } satisfies DownloadCleanupPreviewResponse,
    );
  });

  return router;
}

export default createDownloadCleanupPreviewRouter();
