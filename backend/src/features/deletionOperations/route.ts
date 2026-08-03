import { Hono } from 'hono';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import {
  cancelDeletionOperation,
  getDeletionOperation,
  retryDeletionOperation,
  wakeDeletionWorker,
} from './service.ts';

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

export default router;
