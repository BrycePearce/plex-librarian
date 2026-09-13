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
    return c.json({
      error:
        'Only untouched queued targets or upgrade-held targets without external attempt evidence can be cancelled',
    }, 409);
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

// Legacy adoption and relocation consent cannot be replayed after retirement.
for (
  const path of [
    '/:id/resolve',
    '/:id/targets/:targetId/accept-removed-unmonitored',
    '/:id/targets/:targetId/retry-sonarr-reassignment',
    '/:id/targets/:targetId/finish-relocation',
    '/:id/targets/:targetId/relocation-sync',
  ]
) {
  router.post(path, (c) =>
    c.json({
      error:
        'Legacy recovery has retired. Preserve this operation and review recorded outcomes in the affected services; automatic replay is disabled.',
    }, 410));
}

export default router;
