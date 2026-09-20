import { Hono } from 'hono';
import { withTransaction } from '../../db/index.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import {
  checkHistoricalAccess,
  listHistoricalAccess,
  saveHistoricalAccess,
  scheduleHistoricalAccessChecks,
} from './historicalDownloadAccess.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);
router.get('/', (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ serverId: null, statuses: [] });
  scheduleHistoricalAccessChecks(serverId);
  return c.json({ serverId, statuses: listHistoricalAccess(serverId) });
});
router.post('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  try {
    const body = await c.req.json();
    if (body.id !== undefined && typeof body.id !== 'string') {
      throw new Error('Invalid access record');
    }
    saveHistoricalAccess(serverId, body.instanceId, body.configuration, body.id);
    return c.json({ statuses: listHistoricalAccess(serverId) });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});
router.post('/check', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.id !== 'string') {
    return c.json({ error: 'An access record is required' }, 400);
  }
  if (!listHistoricalAccess(serverId).some((s) => s.id === body.id)) {
    return c.json({ error: 'Access record not found for this server' }, 404);
  }
  await checkHistoricalAccess(serverId, body.id);
  return c.json({ statuses: listHistoricalAccess(serverId) });
});
router.post('/dismiss', (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  withTransaction((db) =>
    db.prepare(
      'UPDATE historical_download_access SET dismissed_revision=problem_revision WHERE server_id=?',
    ).run(serverId)
  );
  return c.json({ statuses: listHistoricalAccess(serverId) });
});
export default router;
