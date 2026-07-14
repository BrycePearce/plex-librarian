import { Hono } from 'hono';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import { arrInstances, arrLibraryMappings, libraries } from '../../db/schema.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import { ArrClient, normalizeArrUrl } from '../../integrations/arr/client.ts';
import { replaceArrInstanceMappings, replaceArrLibraryMappings } from './mappings.ts';
import type {
  ArrIntegrationSettings,
  ArrType,
  SaveArrInstanceRequest,
  SaveArrLibraryMappingRequest,
  UpdateArrInstanceRequest,
} from '@plex-librarian/shared/types.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

const validType = (value: unknown): value is ArrType => value === 'radarr' || value === 'sonarr';

async function validLibrariesForInstance(
  serverId: number,
  type: ArrType,
  value: unknown,
): Promise<string[] | null> {
  if (!Array.isArray(value) || !value.every((key) => typeof key === 'string' && key.length > 0)) {
    return null;
  }
  const keys = [...new Set(value)];
  if (keys.length === 0) return keys;

  const rows = await db.select({ key: libraries.key, type: libraries.type }).from(libraries).where(
    and(eq(libraries.serverId, serverId), inArray(libraries.key, keys)),
  );
  const expectedType = type === 'radarr' ? 'movie' : 'show';
  if (rows.length !== keys.length || rows.some((library) => library.type !== expectedType)) {
    return null;
  }
  return keys;
}

router.get('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);

  const [instances, mappings] = await Promise.all([
    db.select().from(arrInstances).where(eq(arrInstances.serverId, serverId)),
    db.select().from(arrLibraryMappings).where(eq(arrLibraryMappings.serverId, serverId)),
  ]);

  return c.json(
    {
      instances: instances.map((instance) => ({
        id: instance.id,
        type: instance.type,
        name: instance.name,
        url: instance.url,
        apiKeyConfigured: instance.apiKey.length > 0,
      })),
      mappings: mappings.map((mapping) => ({
        libraryKey: mapping.libraryKey,
        instanceId: mapping.arrInstanceId,
        addImportExclusion: mapping.addImportExclusion,
      })),
    } satisfies ArrIntegrationSettings,
  );
});

router.post('/instances', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  const body = await c.req.json().catch(() => null) as SaveArrInstanceRequest | null;
  if (
    !body || !validType(body.type) || typeof body.name !== 'string' || !body.name.trim() ||
    typeof body.url !== 'string' || typeof body.apiKey !== 'string' || !body.apiKey.trim() ||
    typeof body.addImportExclusion !== 'boolean'
  ) {
    return c.json({ error: 'type, name, URL, API key, and mapping options are required' }, 400);
  }

  const libraryKeys = await validLibrariesForInstance(serverId, body.type, body.libraryKeys);
  if (libraryKeys === null) {
    return c.json({ error: 'selected libraries are not valid for this connection' }, 400);
  }

  let url: string;
  try {
    url = normalizeArrUrl(body.url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'invalid URL' }, 400);
  }

  const [duplicate] = await db.select({ id: arrInstances.id }).from(arrInstances).where(and(
    eq(arrInstances.serverId, serverId),
    eq(arrInstances.type, body.type),
    eq(arrInstances.url, url),
  )).limit(1);
  if (duplicate) {
    return c.json({ error: 'this Sonarr or Radarr instance is already configured' }, 409);
  }

  const client = new ArrClient(body.type, url, body.apiKey.trim());
  try {
    await client.testConnection();
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'connection test failed' },
      502,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const createdId = withTransaction((sqliteClient) => {
    const insert = sqliteClient.prepare(
      'INSERT INTO arr_instances ' +
        '(server_id, type, name, url, api_key, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(server_id, type, url) DO NOTHING RETURNING id',
    );
    try {
      const row = insert.value<[number]>(
        serverId,
        body.type,
        body.name.trim(),
        url,
        body.apiKey.trim(),
        now,
        now,
      );
      if (!row) return null;
      replaceArrInstanceMappings(
        sqliteClient,
        serverId,
        row[0],
        libraryKeys,
        body.addImportExclusion,
      );
      return row[0];
    } finally {
      insert.finalize();
    }
  });
  if (createdId === null) {
    return c.json({ error: 'this Sonarr or Radarr instance is already configured' }, 409);
  }

  return c.json({
    id: createdId,
    type: body.type,
    name: body.name.trim(),
    url,
    apiKeyConfigured: true,
  }, 201);
});

router.post('/instances/:id/test', async (c) => {
  const serverId = c.get('activeServerId');
  const id = Number(c.req.param('id'));
  if (serverId === null || !Number.isInteger(id)) {
    return c.json({ error: 'instance not found' }, 404);
  }
  const [instance] = await db.select().from(arrInstances).where(
    and(eq(arrInstances.serverId, serverId), eq(arrInstances.id, id)),
  ).limit(1);
  if (!instance) return c.json({ error: 'instance not found' }, 404);
  try {
    return c.json(
      await new ArrClient(instance.type, instance.url, instance.apiKey).testConnection(),
    );
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'connection test failed' },
      502,
    );
  }
});

router.patch('/instances/:id', async (c) => {
  const serverId = c.get('activeServerId');
  const id = Number(c.req.param('id'));
  if (serverId === null || !Number.isInteger(id)) {
    return c.json({ error: 'instance not found' }, 404);
  }

  const body = await c.req.json().catch(() => null) as UpdateArrInstanceRequest | null;
  if (
    !body || typeof body.name !== 'string' || !body.name.trim() ||
    typeof body.url !== 'string' ||
    (body.apiKey !== undefined && typeof body.apiKey !== 'string') ||
    typeof body.addImportExclusion !== 'boolean'
  ) {
    return c.json({ error: 'name, URL, and mapping options are required' }, 400);
  }

  const [instance] = await db.select().from(arrInstances).where(
    and(eq(arrInstances.serverId, serverId), eq(arrInstances.id, id)),
  ).limit(1);
  if (!instance) return c.json({ error: 'instance not found' }, 404);

  const libraryKeys = await validLibrariesForInstance(
    serverId,
    instance.type,
    body.libraryKeys,
  );
  if (libraryKeys === null) {
    return c.json({ error: 'selected libraries are not valid for this connection' }, 400);
  }

  let url: string;
  try {
    url = normalizeArrUrl(body.url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'invalid URL' }, 400);
  }

  const [duplicate] = await db.select({ id: arrInstances.id }).from(arrInstances).where(and(
    eq(arrInstances.serverId, serverId),
    eq(arrInstances.type, instance.type),
    eq(arrInstances.url, url),
    ne(arrInstances.id, id),
  )).limit(1);
  if (duplicate) {
    return c.json({ error: 'this Sonarr or Radarr instance is already configured' }, 409);
  }

  const replacementApiKey = body.apiKey?.trim();
  const apiKey = replacementApiKey || instance.apiKey;
  try {
    await new ArrClient(instance.type, url, apiKey).testConnection();
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'connection test failed' },
      502,
    );
  }

  withTransaction((sqliteClient) => {
    const update = sqliteClient.prepare(
      'UPDATE arr_instances SET name = ?, url = ?, api_key = ?, updated_at = ? ' +
        'WHERE server_id = ? AND id = ?',
    );
    try {
      update.run(body.name.trim(), url, apiKey, Math.floor(Date.now() / 1000), serverId, id);
    } finally {
      update.finalize();
    }
    replaceArrInstanceMappings(
      sqliteClient,
      serverId,
      id,
      libraryKeys,
      body.addImportExclusion,
    );
  });

  return c.json({
    id,
    type: instance.type,
    name: body.name.trim(),
    url,
    apiKeyConfigured: apiKey.length > 0,
  });
});

router.delete('/instances/:id', async (c) => {
  const serverId = c.get('activeServerId');
  const id = Number(c.req.param('id'));
  if (serverId === null || !Number.isInteger(id)) {
    return c.json({ error: 'instance not found' }, 404);
  }
  await db.delete(arrInstances).where(
    and(eq(arrInstances.serverId, serverId), eq(arrInstances.id, id)),
  );
  return c.json({ ok: true as const });
});

router.put('/libraries/:key', async (c) => {
  const serverId = c.get('activeServerId');
  const key = c.req.param('key');
  if (serverId === null) return c.json({ error: 'library not found' }, 404);
  const body = await c.req.json().catch(() => null) as SaveArrLibraryMappingRequest | null;
  if (
    !body || !Array.isArray(body.instanceIds) ||
    !body.instanceIds.every((id) => Number.isInteger(id)) ||
    typeof body.addImportExclusion !== 'boolean'
  ) {
    return c.json({ error: 'instanceIds and addImportExclusion are required' }, 400);
  }
  const instanceIds = [...new Set(body.instanceIds)];
  const [library] = await db.select({ type: libraries.type }).from(libraries).where(
    and(eq(libraries.serverId, serverId), eq(libraries.key, key)),
  ).limit(1);
  if (!library) return c.json({ error: 'library not found' }, 404);

  if (instanceIds.length > 0) {
    const expectedType = library.type === 'movie'
      ? 'radarr'
      : library.type === 'show'
      ? 'sonarr'
      : null;
    if (!expectedType) {
      return c.json({ error: 'Arr mappings support movie and show libraries only' }, 400);
    }
    const owned = await db.select({ id: arrInstances.id, type: arrInstances.type }).from(
      arrInstances,
    )
      .where(and(eq(arrInstances.serverId, serverId), inArray(arrInstances.id, instanceIds)));
    if (
      owned.length !== instanceIds.length ||
      owned.some((instance) => instance.type !== expectedType)
    ) {
      return c.json({ error: `all mapped instances must be ${expectedType}` }, 400);
    }
  }

  // Replacement must be atomic: a concurrent instance removal or insert failure must
  // not silently discard the library's previously valid mappings.
  withTransaction((client) =>
    replaceArrLibraryMappings(client, serverId, key, instanceIds, body.addImportExclusion)
  );
  return c.json({ ok: true as const });
});

export default router;
