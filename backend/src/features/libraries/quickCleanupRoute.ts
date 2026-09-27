import { Hono } from 'hono';
import { db } from '../../db/index.ts';
import { libraries } from '../../db/schema.ts';
import { libraryByKey } from '../../db/scope.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import type { ActiveServerVariables } from '../../middleware/activeServer.ts';
import type {
  StaleQuickCleanupOrder,
  StaleQuickCleanupResponse,
  StaleQuickCleanupSort,
} from '@plex-librarian/shared/types.ts';
import {
  assertRelocationWorkflowClear,
  RelocationConflictError,
} from '../deletionOperations/relocation/relocation.ts';
import { automaticQuickCleanupThresholdDays } from './automaticStaleThreshold.ts';
import {
  analyzeStaleQuickCleanup,
  parseStaleQuickCleanupDays,
  staleQuickCleanupActiveProtection,
} from './quickCleanup.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();

router.get('/:key/stale/quick-cleanup', async (c) => {
  const key = c.req.param('key');
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'library not found' }, 404);
  try {
    assertRelocationWorkflowClear(serverId, key);
  } catch (error) {
    if (error instanceof RelocationConflictError) return c.json({ error: error.message }, 409);
    throw error;
  }
  const [library] = await db.select({ oldestItemAddedAt: libraries.oldestItemAddedAt })
    .from(libraries)
    .where(libraryByKey(serverId, key))
    .limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);
  const now = Math.floor(Date.now() / 1000);
  const rawDays = c.req.query('days') ??
    String(automaticQuickCleanupThresholdDays(library.oldestItemAddedAt, now));
  const thresholdDays = parseStaleQuickCleanupDays(rawDays);
  if (thresholdDays === null) {
    return c.json({ error: 'days must be an integer between 180 and 3650' }, 400);
  }
  const rawSort = c.req.query('sort') ?? 'fileSize';
  if (rawSort !== 'fileSize' && rawSort !== 'inactiveSince') {
    return c.json({ error: 'sort must be fileSize or inactiveSince' }, 400);
  }
  const sort: StaleQuickCleanupSort = rawSort;
  const rawOrder = c.req.query('order') ?? 'desc';
  if (rawOrder !== 'asc' && rawOrder !== 'desc') {
    return c.json({ error: 'order must be asc or desc' }, 400);
  }
  const order: StaleQuickCleanupOrder = rawOrder;
  const analysis = analyzeStaleQuickCleanup(serverId, key, thresholdDays, now, [], sort, order);
  if (!analysis) return c.json({ error: 'library not found' }, 404);
  if (!analysis.eligible || analysis.candidates.length === 0) {
    return c.json(analysis satisfies StaleQuickCleanupResponse);
  }
  try {
    const activeServer = await resolveActiveServer();
    if (activeServer.serverId !== serverId) {
      return c.json({ error: 'the active Plex server changed during analysis' }, 409);
    }
    const sessions = await activeServer.client.activeSessions();
    const activeRatingKeys = new Set(
      sessions.flatMap((session) =>
        session.grandparentRatingKey
          ? [session.ratingKey, session.grandparentRatingKey]
          : [session.ratingKey]
      ),
    );
    const active = staleQuickCleanupActiveProtection(
      serverId,
      key,
      thresholdDays,
      activeRatingKeys,
      now,
    );
    const refreshed = analyzeStaleQuickCleanup(
      serverId,
      key,
      thresholdDays,
      now,
      [...active.ratingKeys],
      sort,
      order,
    );
    if (!refreshed) return c.json({ error: 'library not found' }, 404);
    return c.json(
      {
        ...refreshed,
        activePlaybackProtectedCount: active.count,
      } satisfies StaleQuickCleanupResponse,
    );
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not check active playback',
    }, 502);
  }
});

export default router;
