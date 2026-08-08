import { Hono } from 'hono';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import {
  cancelDeletionOperation,
  getDeletionOperation,
  retryDeletionOperation,
  wakeDeletionWorker,
} from './service.ts';
import { finishRelocation, RelocationConflictError } from './relocation.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import { triggerLibrarySync } from '../sync/manager.ts';
import { ManagementHoldConflictError, resolveRadarrManagementHold } from './resolution.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

router.get('/:id', (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'operation not found' }, 404);
  const operation = getDeletionOperation(c.req.param('id'), serverId);
  return operation ? c.json(operation) : c.json({ error: 'operation not found' }, 404);
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
  const outcome = body.outcome ?? 'needs_attention';
  if (outcome !== 'needs_attention' && outcome !== 'warning') {
    return c.json({ error: 'outcome must be needs_attention or warning' }, 400);
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
