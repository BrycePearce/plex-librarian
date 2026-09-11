import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, type SqliteClient, withTransaction } from '../../db/index.ts';
import { servicePathRoots } from '../../db/schema.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import {
  evidenceFingerprint,
  loadServiceRoots,
  serviceEndpoints,
} from '../mediaDeletion/serviceStorage.ts';
import { storageContains, storagePath } from '../../../../shared/serviceStorage.ts';
import { automaticStorage } from './automaticStorage.ts';
import { dockerStorage } from './dockerStorage.ts';
import {
  disableHostDiscovery,
  enableHostDiscovery,
  hostDiscoveryStatus,
  triggerHostDiscovery,
} from './hostDiscovery.ts';

// Bind a slow discovery request to the configuration present when it began.
// Credentials remain inside this digest and are never returned to clients.
function configurationSnapshot(client: SqliteClient, serverId: number): string {
  return evidenceFingerprint([
    client.prepare('SELECT active_server_id FROM settings WHERE id=1').all(),
    client.prepare('SELECT id,machine_identifier,url,access_token FROM servers WHERE id=?').all(
      serverId,
    ),
    client.prepare('SELECT key,type FROM libraries WHERE server_id=? ORDER BY key').all(serverId),
    client.prepare(
      'SELECT * FROM arr_library_mappings WHERE server_id=? ORDER BY library_key,arr_instance_id',
    ).all(serverId),
    ...['arr_instances', 'qbittorrent_instances', 'service_path_roots'].map((table) =>
      client.prepare(`SELECT * FROM ${table} WHERE server_id=? ORDER BY id`).all(serverId)
    ),
  ]);
}

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);
for (const action of ['enable', 'retry', 'disable'] as const) {
  router.post(`/discovery/${action}`, async (c) => {
    const serverId = c.get('activeServerId');
    if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
    try {
      if (action === 'enable') await enableHostDiscovery(serverId);
      if (action === 'disable') disableHostDiscovery(serverId);
      if (action === 'retry') triggerHostDiscovery(serverId);
      return c.json(hostDiscoveryStatus(serverId));
    } catch {
      return c.json({
        error:
          'Could not pair host discovery. Check the helper installation and its shared directory. A changed host must be explicitly unpaired in Advanced.',
      }, 409);
    }
  });
}
router.get('/docker-report.sh', async (c) => {
  const script = (await Deno.readTextFile(new URL('./docker-report.sh', import.meta.url)))
    .replaceAll('\r\n', '\n');
  c.header('Content-Disposition', 'attachment; filename="librarian-docker-report.sh"');
  c.header('Content-Type', 'text/x-shellscript; charset=utf-8');
  return c.body(script);
});
for (const action of ['docker-preview', 'docker-confirm'] as const) {
  router.post(`/${action}`, async (c) => {
    const serverId = c.get('activeServerId');
    if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
    if (Number(c.req.header('content-length')) > 2_100_000) {
      return c.json({ error: 'Docker report is too large' }, 413);
    }
    const raw = await c.req.text();
    if (raw.length > 2_100_000) return c.json({ error: 'Docker report is too large' }, 413);
    const body = (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();
    if (typeof body?.report !== 'string') {
      return c.json({ error: 'Import the Docker mount report' }, 400);
    }
    try {
      const before = withTransaction((client) => configurationSnapshot(client, serverId));
      const endpoints = await serviceEndpoints(serverId, true);
      const roots = await loadServiceRoots(serverId);
      const { preview, relationships } = dockerStorage(
        body.report,
        endpoints,
        roots,
        Date.now(),
        body.selections,
      );
      if (action === 'docker-preview') return c.json(preview);
      if (
        body.confirmed !== true || !preview.fingerprint ||
        preview.fingerprint !== body.fingerprint || preview.status === 'unavailable'
      ) throw new Error('The Docker proposal changed. Review the report again before saving.');
      if (preview.replacementRequired && body.replaceExisting !== true) {
        throw new Error('Review and explicitly approve replacing the existing relationships.');
      }
      withTransaction((client) => {
        if (configurationSnapshot(client, serverId) !== before) {
          throw new Error(
            'Connections or storage relationships changed during discovery. Review the report again.',
          );
        }
        if (preview.status === 'ready') return;
        client.prepare('DELETE FROM service_path_roots WHERE server_id=?').run(serverId);
        for (const root of relationships) {
          client.prepare(
            'INSERT INTO service_path_roots (server_id,service_key,configuration_identity,service_root,storage_root,case_sensitive,has_aliases) VALUES (?,?,?,?,?,?,?)',
          ).run(
            serverId,
            root.serviceKey,
            root.configurationIdentity,
            root.serviceRoot,
            root.storageRoot,
            Number(root.caseSensitive),
            Number(root.hasAliases),
          );
        }
      });
      const saved = await loadServiceRoots(serverId);
      return c.json({
        endpoints,
        relationships: saved,
        automation: automaticStorage(endpoints, saved),
      }, 201);
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'Docker report validation failed',
      }, 409);
    }
  });
}
router.get('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  const relationships = await loadServiceRoots(serverId);
  const discover = c.req.query('discover') === 'true';
  const endpoints = await serviceEndpoints(serverId, discover);
  return c.json({
    endpoints,
    relationships,
    discovery: hostDiscoveryStatus(serverId),
    // Legacy diagnostic consumers remain until the native-host acceptance gate.
    ...(discover ? { automation: automaticStorage(endpoints, relationships) } : {}),
  });
});
router.post('/confirm', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  const body = await c.req.json().catch(() => null);
  if (body?.confirmed !== true || typeof body.fingerprint !== 'string') {
    return c.json({ error: 'Confirm the proposed shared storage layout' }, 400);
  }
  try {
    const before = withTransaction((client) => configurationSnapshot(client, serverId));
    const endpoints = await serviceEndpoints(serverId, true);
    const roots = await loadServiceRoots(serverId);
    const automation = automaticStorage(endpoints, roots);
    const proposal = automation.proposal;
    if (
      automation.status !== 'confirmation_required' || !proposal ||
      proposal.fingerprint !== body.fingerprint
    ) {
      throw new Error(
        'The proposed storage layout changed. Refresh connections and review it again.',
      );
    }
    withTransaction((client) => {
      if (configurationSnapshot(client, serverId) !== before) {
        throw new Error(
          'Connections or storage relationships changed during discovery. Refresh setup.',
        );
      }
      for (const root of proposal.relationships) {
        client.prepare(
          'INSERT INTO service_path_roots (server_id,service_key,configuration_identity,service_root,storage_root,case_sensitive,has_aliases) VALUES (?,?,?,?,?,?,?)',
        ).run(
          serverId,
          root.serviceKey,
          root.configurationIdentity,
          root.serviceRoot,
          root.storageRoot,
          Number(root.caseSensitive),
          Number(root.hasAliases),
        );
      }
    });
    const relationships = await loadServiceRoots(serverId);
    return c.json({
      endpoints,
      relationships,
      automation: automaticStorage(endpoints, relationships),
    }, 201);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Storage confirmation failed' },
      409,
    );
  }
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
        // Explicit editing changes provenance to manual. Automatic refresh must
        // never reclaim this row or overwrite this user's declared scope.
        client.prepare('DELETE FROM host_discovery_roots WHERE root_id=?').run(body.id);
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
    triggerHostDiscovery(serverId);
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
  triggerHostDiscovery(serverId);
  return c.json({ ok: true });
});
export default router;
