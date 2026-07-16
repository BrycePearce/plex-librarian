import { Hono, type MiddlewareHandler } from 'hono';
import { and, inArray } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import { items } from '../../db/schema.ts';
import { itemsByLibrary } from '../../db/scope.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import type { DownloadCleanupPreviewResponse } from '@plex-librarian/shared/types.ts';
import { findAmbiguousExternalIds, getArrDeleteTargets } from '../arr/delete.ts';
import { publicCleanupItem, reconcileSharedDownloadCleanups } from './cleanup.ts';
import {
  loadAttemptedArrInstancesByItem,
  loadAttemptedDownloadJobKeysByItem,
  loadAttemptedOrphanFilesByItem,
  resolveDownloadCleanupBatch,
} from './planning.ts';
import { getDownloadClientTargets } from './targets.ts';

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
    const ratingKeys = [...new Set(body.ratingKeys)];
    const owned = await db.select({
      ratingKey: items.ratingKey,
      title: items.title,
      type: items.type,
      tmdbId: items.tmdbId,
      tvdbId: items.tvdbId,
    }).from(items).where(and(itemsByLibrary(serverId, key), inArray(items.ratingKey, ratingKeys)));
    const [arrTargets, downloadTargets] = await Promise.all([
      getArrDeleteTargets(serverId, key),
      getDownloadClientTargets(serverId),
    ]);
    const [attemptedKeys, attemptedOrphans, attemptedArrInstances] = await Promise.all([
      loadAttemptedDownloadJobKeysByItem(serverId, owned.map((item) => item.ratingKey)),
      loadAttemptedOrphanFilesByItem(serverId, owned.map((item) => item.ratingKey)),
      loadAttemptedArrInstancesByItem(
        serverId,
        owned,
        arrTargets.map((target) => target.instanceId),
      ),
    ]);
    const ambiguousByType = new Map<string, Set<number>>();
    for (const type of ['movie', 'show'] as const) {
      const ids = owned.flatMap((item) => {
        if (item.type !== type) return [];
        const id = type === 'movie' ? item.tmdbId : item.tvdbId;
        return id === null ? [] : [id];
      });
      ambiguousByType.set(
        type,
        withTransaction((client) => findAmbiguousExternalIds(client, serverId, type, ids)),
      );
    }
    const previews = reconcileSharedDownloadCleanups(
      await resolveDownloadCleanupBatch(
        owned,
        arrTargets,
        downloadTargets,
        attemptedKeys,
        attemptedOrphans,
        attemptedArrInstances,
      ),
    ).map((resolved) => {
      const item = owned.find((candidate) => candidate.ratingKey === resolved.ratingKey)!;
      const externalId = item.type === 'movie' ? item.tmdbId : item.tvdbId;
      if (externalId !== null && ambiguousByType.get(item.type)?.has(externalId)) {
        const reason = `${item.title} shares its ${
          item.type === 'movie' ? 'TMDB' : 'TVDB'
        } ID with another Plex item`;
        return publicCleanupItem({
          ...resolved,
          status: 'error',
          reason,
          arrStatus: 'error',
          arrReason: `${reason}; use Plex-only deletion or resolve the duplicate first`,
          downloadJobs: [],
          orphanFiles: [],
          retainedPaths: [],
        });
      }
      return publicCleanupItem(resolved);
    });
    for (const ratingKey of ratingKeys) {
      if (owned.some((item) => item.ratingKey === ratingKey)) continue;
      previews.push({
        ratingKey,
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
