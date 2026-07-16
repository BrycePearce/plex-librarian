import { Hono } from 'hono';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import type { MediaRemovalSummary } from '@plex-librarian/shared/types.ts';
import { getMediaRemovalSummary } from './service.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

router.get('/summary', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) {
    return c.json(
      {
        mediaSizeRemoved: 0,
        removalCount: 0,
        unknownSizeCount: 0,
      } satisfies MediaRemovalSummary,
    );
  }
  return c.json(await getMediaRemovalSummary(serverId) satisfies MediaRemovalSummary);
});

export default router;
