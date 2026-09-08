import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import { servicePathRoots } from '../../db/schema.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import { loadServiceRoots, serviceEndpoints } from '../mediaDeletion/serviceStorage.ts';
import { storageContains, storagePath } from '../../../../shared/serviceStorage.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);
router.get('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  return c.json({
    endpoints: await serviceEndpoints(serverId, c.req.query('discover') === 'true'),
    relationships: await loadServiceRoots(serverId),
  });
});
router.post('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  const body = await c.req.json().catch(() => null);
  if (
    !body || typeof body.serviceKey !== 'string' || typeof body.serviceRoot !== 'string' ||
    typeof body.storageRoot !== 'string' || typeof body.caseSensitive !== 'boolean' ||
    typeof body.hasAliases !== 'boolean' || body.confirmed !== true
  ) {
    return c.json({
      error: 'Confirm the service root, shared storage root, case rules and alias declaration',
    }, 400);
  }
  try {
    const endpoint = (await serviceEndpoints(serverId)).find((entry) =>
      entry.key === body.serviceKey
    );
    if (!endpoint || endpoint.configurationIdentity !== body.configurationIdentity) {
      throw new Error('The connection changed; refresh setup');
    }
    const serviceRoot = storagePath(body.serviceRoot), storageRoot = storagePath(body.storageRoot);
    const value = withTransaction((client) => {
      const existing = client.prepare(
        'SELECT id, service_root, storage_root, case_sensitive, revision FROM service_path_roots WHERE server_id = ? AND service_key = ?',
      ).all<
        {
          id: number;
          service_root: string;
          storage_root: string;
          case_sensitive: number;
          revision: number;
        }
      >(serverId, body.serviceKey);
      if (
        body.id !== undefined &&
        !existing.some((root) => root.id === body.id && root.revision === body.revision)
      ) throw new Error('The relationship changed; refresh setup');
      for (const root of existing.filter((root) => root.id !== body.id)) {
        if (
          storageContains(root.service_root, serviceRoot, false) ||
          storageContains(serviceRoot, root.service_root, false) ||
          storageContains(root.storage_root, storageRoot, false) ||
          storageContains(storageRoot, root.storage_root, false)
        ) throw new Error('Overlapping or aliased relationships for one service are ambiguous');
      }
      if (body.id !== undefined) {
        client.prepare(
          'UPDATE service_path_roots SET service_root=?,storage_root=?,case_sensitive=?,has_aliases=?,configuration_identity=?,revision=revision+1 WHERE id=? AND server_id=?',
        ).run(
          serviceRoot,
          storageRoot,
          Number(body.caseSensitive),
          Number(body.hasAliases),
          endpoint.configurationIdentity,
          body.id,
          serverId,
        );
        return body.id;
      }
      return client.prepare(
        'INSERT INTO service_path_roots (server_id,service_key,configuration_identity,service_root,storage_root,case_sensitive,has_aliases) VALUES (?,?,?,?,?,?,?) RETURNING id',
      ).value<[number]>(
        serverId,
        body.serviceKey,
        endpoint.configurationIdentity,
        serviceRoot,
        storageRoot,
        Number(body.caseSensitive),
        Number(body.hasAliases),
      )![0];
    });
    return c.json({ id: value }, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Invalid storage relationship',
    }, 409);
  }
});
router.delete('/:id', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  await db.delete(servicePathRoots).where(
    and(
      eq(servicePathRoots.id, Number(c.req.param('id'))),
      eq(servicePathRoots.serverId, serverId),
    ),
  );
  return c.json({ ok: true });
});
export default router;
