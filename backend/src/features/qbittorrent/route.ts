import { Hono } from 'hono';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { qbittorrentInstances } from '../../db/schema.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import {
  normalizeQbittorrentUrl,
  QbittorrentClient,
} from '../../integrations/qbittorrent/client.ts';
import { envQbittorrentConfigured } from './connections.ts';
import type {
  QbittorrentIntegrationSettings,
  SaveQbittorrentInstanceRequest,
  UpdateQbittorrentInstanceRequest,
} from '@plex-librarian/shared/types.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

function publicInstance(instance: typeof qbittorrentInstances.$inferSelect) {
  return {
    id: instance.id,
    name: instance.name,
    url: instance.url,
    usernameConfigured: instance.username.length > 0,
    passwordConfigured: instance.password.length > 0,
  };
}

router.get('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  const instances = await db.select().from(qbittorrentInstances).where(
    eq(qbittorrentInstances.serverId, serverId),
  );
  return c.json(
    {
      envConfigured: envQbittorrentConfigured(),
      instances: instances.map(publicInstance),
    } satisfies QbittorrentIntegrationSettings,
  );
});

router.post('/instances', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);
  if (envQbittorrentConfigured()) {
    return c.json({ error: 'qBittorrent is configured by environment variables' }, 409);
  }
  const body = await c.req.json().catch(() => null) as SaveQbittorrentInstanceRequest | null;
  if (
    !body || typeof body.name !== 'string' || !body.name.trim() ||
    typeof body.url !== 'string' || typeof body.username !== 'string' ||
    typeof body.password !== 'string'
  ) return c.json({ error: 'name and URL are required' }, 400);

  let url: string;
  try {
    url = normalizeQbittorrentUrl(body.url);
    await new QbittorrentClient(url, body.username, body.password).testConnection();
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'connection test failed' },
      502,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    const [created] = await db.insert(qbittorrentInstances).values({
      serverId,
      name: body.name.trim(),
      url,
      username: body.username,
      password: body.password,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return c.json(publicInstance(created), 201);
  } catch {
    return c.json({ error: 'this qBittorrent instance is already configured' }, 409);
  }
});

router.post('/instances/:id/test', async (c) => {
  const serverId = c.get('activeServerId');
  const id = Number(c.req.param('id'));
  if (serverId === null || !Number.isInteger(id)) {
    return c.json({ error: 'instance not found' }, 404);
  }
  const [instance] = await db.select().from(qbittorrentInstances).where(and(
    eq(qbittorrentInstances.serverId, serverId),
    eq(qbittorrentInstances.id, id),
  )).limit(1);
  if (!instance) return c.json({ error: 'instance not found' }, 404);
  try {
    return c.json(
      await new QbittorrentClient(
        instance.url,
        instance.username,
        instance.password,
      ).testConnection(),
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
  if (envQbittorrentConfigured()) {
    return c.json({ error: 'qBittorrent is configured by environment variables' }, 409);
  }
  const body = await c.req.json().catch(() => null) as UpdateQbittorrentInstanceRequest | null;
  if (
    !body || typeof body.name !== 'string' || !body.name.trim() ||
    typeof body.url !== 'string' ||
    (body.username !== undefined && typeof body.username !== 'string') ||
    (body.password !== undefined && typeof body.password !== 'string')
  ) return c.json({ error: 'name and URL are required' }, 400);
  const [instance] = await db.select().from(qbittorrentInstances).where(and(
    eq(qbittorrentInstances.serverId, serverId),
    eq(qbittorrentInstances.id, id),
  )).limit(1);
  if (!instance) return c.json({ error: 'instance not found' }, 404);
  let url: string;
  try {
    url = normalizeQbittorrentUrl(body.url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'invalid URL' }, 400);
  }
  const [duplicate] = await db.select({ id: qbittorrentInstances.id }).from(qbittorrentInstances)
    .where(and(
      eq(qbittorrentInstances.serverId, serverId),
      eq(qbittorrentInstances.url, url),
      ne(qbittorrentInstances.id, id),
    )).limit(1);
  if (duplicate) return c.json({ error: 'this qBittorrent instance is already configured' }, 409);
  const username = body.username ?? instance.username;
  const password = body.password ?? instance.password;
  try {
    await new QbittorrentClient(url, username, password).testConnection();
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'connection test failed' },
      502,
    );
  }
  const [updated] = await db.update(qbittorrentInstances).set({
    name: body.name.trim(),
    url,
    username,
    password,
    updatedAt: Math.floor(Date.now() / 1000),
  }).where(and(
    eq(qbittorrentInstances.serverId, serverId),
    eq(qbittorrentInstances.id, id),
  )).returning();
  return c.json(publicInstance(updated));
});

router.delete('/instances/:id', async (c) => {
  const serverId = c.get('activeServerId');
  const id = Number(c.req.param('id'));
  if (serverId === null || !Number.isInteger(id)) {
    return c.json({ error: 'instance not found' }, 404);
  }
  await db.delete(qbittorrentInstances).where(and(
    eq(qbittorrentInstances.serverId, serverId),
    eq(qbittorrentInstances.id, id),
  ));
  return c.json({ ok: true as const });
});

export default router;
