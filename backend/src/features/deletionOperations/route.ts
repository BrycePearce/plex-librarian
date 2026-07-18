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

router.post('/:id/retry', (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null || !retryDeletionOperation(c.req.param('id'), serverId)) {
    return c.json({ error: 'operation not found' }, 404);
  }
  wakeDeletionWorker();
  return c.json(getDeletionOperation(c.req.param('id'), serverId));
});

export default router;
