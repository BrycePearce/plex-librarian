import { Hono } from 'hono';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import {
  cancelDeletionOperation,
  deletionOperationArrLinks,
  dismissDeletionOperation,
  getDeletionOperation,
  listDeletionOperations,
  retryDeletionOperation,
  wakeDeletionWorker,
} from './service.ts';
import { finishRelocation, RelocationConflictError } from './relocation/relocation.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import { triggerLibrarySync } from '../sync/manager.ts';
import {
  ManagementHoldConflictError,
  resolveRadarrManagementHold,
} from './relocation/resolution.ts';
import {
  acceptSonarrRemovedAndUnmonitored,
  retrySonarrSeasonReassignment,
  SonarrSeasonRecoveryConflictError,
} from './recovery/sonarrSeason.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

const OPERATION_STATUSES = new Set(
  [
    'queued',
    'running',
    'waiting_retry',
    'completed',
    'completed_with_warning',
    'needs_attention',
    'cancelled',
  ] as const,
);

router.get('/', (c) => {
  const serverId = c.get('activeServerId');
  const rawStatus = c.req.query('status');
  const attention = c.req.query('attention') === 'true';
  if (rawStatus && !OPERATION_STATUSES.has(rawStatus as never)) {
    return c.json({ error: 'invalid deletion operation status' }, 400);
  }
  const rawLimit = Number(c.req.query('limit') ?? 20);
  const rawOffset = Number(c.req.query('offset') ?? 0);
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  if (serverId === null) {
    return c.json({
      status: rawStatus ?? null,
      attention,
      limit,
      offset,
      total: 0,
      operations: [],
    });
  }
  const result = listDeletionOperations(serverId, {
    ...(rawStatus
      ? { status: rawStatus as Parameters<typeof listDeletionOperations>[1]['status'] }
      : {}),
    attention,
    limit,
    offset,
  });
  return c.json({ status: rawStatus ?? null, attention, limit, offset, ...result });
});

router.get('/:id', (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'operation not found' }, 404);
  const operation = getDeletionOperation(c.req.param('id'), serverId);
  return operation ? c.json(operation) : c.json({ error: 'operation not found' }, 404);
});

router.get('/:id/arr-links', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'operation not found' }, 404);
  const links = await deletionOperationArrLinks(c.req.param('id'), serverId);
  return links === null ? c.json({ error: 'operation not found' }, 404) : c.json({ links });
});

router.post('/:id/cancel', (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null || !cancelDeletionOperation(c.req.param('id'), serverId)) {
    return c.json({ error: 'only queued targets can be cancelled' }, 409);
  }
  wakeDeletionWorker();
  return c.json(getDeletionOperation(c.req.param('id'), serverId));
});

router.post('/:id/retry', async (c) => {
  const serverId = c.get('activeServerId');
  const body = await c.req.json().catch(() => ({})) as { outcome?: unknown };
  const outcome = body.outcome ?? 'all';
  if (outcome !== 'needs_attention' && outcome !== 'warning' && outcome !== 'all') {
    return c.json({ error: 'outcome must be needs_attention, warning, or all' }, 400);
  }
  if (serverId === null) return c.json({ error: 'operation not found' }, 404);
  if (!getDeletionOperation(c.req.param('id'), serverId)) {
    return c.json({ error: 'operation not found' }, 404);
  }
  if (!retryDeletionOperation(c.req.param('id'), serverId, outcome)) {
    return c.json({ error: 'no matching targets can be retried' }, 409);
  }
  wakeDeletionWorker();
  return c.json(getDeletionOperation(c.req.param('id'), serverId));
});

router.post('/:id/dismiss', async (c) => {
  const serverId = c.get('activeServerId');
  const body = await c.req.json().catch(() => ({})) as { acknowledge?: unknown };
  if (body.acknowledge !== true) {
    return c.json({ error: 'acknowledge must be true' }, 400);
  }
  if (serverId === null || !getDeletionOperation(c.req.param('id'), serverId)) {
    return c.json({ error: 'operation not found' }, 404);
  }
  if (!dismissDeletionOperation(c.req.param('id'), serverId)) {
    return c.json({ error: 'no matching targets can be dismissed' }, 409);
  }
  return c.json(getDeletionOperation(c.req.param('id'), serverId));
});

router.post('/:id/resolve', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'operation not found' }, 404);
  try {
    const resolution = await resolveRadarrManagementHold(c.req.param('id'), serverId);
    if (resolution === 'resumed') wakeDeletionWorker();
    return c.json({ resolution, operation: getDeletionOperation(c.req.param('id'), serverId) });
  } catch (error) {
    if (error instanceof ManagementHoldConflictError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
});

router.post('/:id/targets/:targetId/accept-removed-unmonitored', async (c) => {
  const serverId = c.get('activeServerId');
  const body = await c.req.json().catch(() => ({})) as { acknowledge?: unknown };
  if (body.acknowledge !== true) return c.json({ error: 'acknowledge must be true' }, 400);
  if (serverId === null) return c.json({ error: 'operation not found' }, 404);
  try {
    await acceptSonarrRemovedAndUnmonitored(
      c.req.param('id'),
      Number(c.req.param('targetId')),
      serverId,
    );
    wakeDeletionWorker();
    return c.json(getDeletionOperation(c.req.param('id'), serverId));
  } catch (error) {
    if (error instanceof SonarrSeasonRecoveryConflictError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
});

router.post('/:id/targets/:targetId/retry-sonarr-reassignment', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'operation not found' }, 404);
  try {
    await retrySonarrSeasonReassignment(
      c.req.param('id'),
      Number(c.req.param('targetId')),
      serverId,
    );
    wakeDeletionWorker();
    return c.json(getDeletionOperation(c.req.param('id'), serverId));
  } catch (error) {
    if (error instanceof SonarrSeasonRecoveryConflictError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
});

router.post('/:id/targets/:targetId/finish-relocation', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'operation not found' }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.guidanceId !== 'string') {
    return c.json({ error: 'guidanceId is required' }, 400);
  }
  try {
    const result = finishRelocation(
      c.req.param('id'),
      Number(c.req.param('targetId')),
      serverId,
      body.guidanceId,
      body.destinationPlaybackConfirmed === true,
    );
    let sync: { syncId: number } | { conflict: number } | { deferred: true } | { completed: true };
    if (result.barrier.finishedAt !== undefined) {
      sync = { completed: true };
    } else if (result.syncDeferred) {
      sync = { deferred: true };
    } else {
      try {
        const active = await resolveActiveServer();
        sync = active.serverId === serverId
          ? triggerLibrarySync(active, result.libraryKey)
          : { deferred: true };
      } catch {
        // Supersede is already durably committed. Server resolution and sync startup
        // are best-effort orchestration; keep the incomplete barrier actionable.
        sync = { deferred: true };
      }
    }
    return c.json({ operation: getDeletionOperation(c.req.param('id'), serverId), sync });
  } catch (error) {
    if (error instanceof RelocationConflictError) {
      return c.json({ error: error.message }, error.status as 400 | 404 | 409);
    }
    throw error;
  }
});

router.post('/:id/targets/:targetId/relocation-sync', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'operation not found' }, 404);
  const operation = getDeletionOperation(c.req.param('id'), serverId) as
    | { libraryKey?: unknown; targets?: Array<Record<string, unknown>> }
    | null;
  const targetId = Number(c.req.param('targetId'));
  const target = operation?.targets?.find((entry) => entry.id === targetId);
  const barrier = target?.relocationSyncBarrier as { finishedAt?: number } | undefined;
  if (
    !Number.isSafeInteger(targetId) || targetId <= 0 || !operation ||
    typeof operation.libraryKey !== 'string' || !barrier
  ) {
    return c.json({ error: 'incomplete relocation barrier not found' }, 404);
  }
  if (target?.relocationSyncBarrierState === 'completed') {
    return c.json({ operation, sync: { completed: true } });
  }
  if (target?.relocationSyncBarrierState !== 'incomplete') {
    return c.json({ error: 'incomplete relocation barrier not found' }, 404);
  }
  const active = await resolveActiveServer();
  if (active.serverId !== serverId) return c.json({ error: 'the active server changed' }, 409);
  const sync = triggerLibrarySync(active, operation.libraryKey);
  return c.json({ operation, sync });
});

export default router;
