import { Hono } from 'hono';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { seerrInstances } from '../../db/schema.ts';
import { normalizeSeerrUrl, SeerrClient } from '../../integrations/seerr/client.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import type {
  SaveSeerrInstanceRequest,
  SeerrIntegrationSettings,
  UpdateSeerrInstanceRequest,
} from '@plex-librarian/shared/types.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

function publicInstance(instance: typeof seerrInstances.$inferSelect) {
  return {
    id: instance.id,
    name: instance.name,
    url: instance.url,
    apiKeyConfigured: instance.apiKey.length > 0,
  };
}

router.get('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) {
    return c.json({ error: 'Plex is not configured' }, 409);
  }
  const instances = await db
    .select()
    .from(seerrInstances)
    .where(eq(seerrInstances.serverId, serverId));
  return c.json(
    {
      instances: instances.map(publicInstance),
    } satisfies SeerrIntegrationSettings,
  );
});

router.post('/instances', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) {
    return c.json({ error: 'Plex is not configured' }, 409);
  }
  const body = (await c.req
    .json()
    .catch(() => null)) as SaveSeerrInstanceRequest | null;
  if (
    !body ||
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    typeof body.url !== 'string' ||
    typeof body.apiKey !== 'string' ||
    !body.apiKey.trim()
  ) {
    return c.json({ error: 'name, URL, and API key are required' }, 400);
  }

  let url: string;
  try {
    url = normalizeSeerrUrl(body.url);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'invalid URL' },
      400,
    );
  }
  const [duplicate] = await db
    .select({ id: seerrInstances.id })
    .from(seerrInstances)
    .where(
      and(eq(seerrInstances.serverId, serverId), eq(seerrInstances.url, url)),
    )
    .limit(1);
  if (duplicate) {
    return c.json({ error: 'this Seerr instance is already configured' }, 409);
  }

  const apiKey = body.apiKey.trim();
  try {
    await new SeerrClient(url, apiKey).testConnection();
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : 'connection test failed',
      },
      502,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    const [created] = await db
      .insert(seerrInstances)
      .values({
        serverId,
        name: body.name.trim(),
        url,
        apiKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return c.json(publicInstance(created), 201);
  } catch {
    return c.json({ error: 'this Seerr instance is already configured' }, 409);
  }
});

router.post('/instances/:id/test', async (c) => {
  const serverId = c.get('activeServerId');
  const id = Number(c.req.param('id'));
  if (serverId === null || !Number.isInteger(id)) {
    return c.json({ error: 'instance not found' }, 404);
  }
  const [instance] = await db
    .select()
    .from(seerrInstances)
    .where(
      and(eq(seerrInstances.serverId, serverId), eq(seerrInstances.id, id)),
    )
    .limit(1);
  if (!instance) return c.json({ error: 'instance not found' }, 404);
  try {
    return c.json(
      await new SeerrClient(instance.url, instance.apiKey).testConnection(),
    );
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : 'connection test failed',
      },
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
  const body = (await c.req
    .json()
    .catch(() => null)) as UpdateSeerrInstanceRequest | null;
  if (
    !body ||
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    typeof body.url !== 'string' ||
    (body.apiKey !== undefined && typeof body.apiKey !== 'string')
  ) {
    return c.json({ error: 'name and URL are required' }, 400);
  }

  const [instance] = await db
    .select()
    .from(seerrInstances)
    .where(
      and(eq(seerrInstances.serverId, serverId), eq(seerrInstances.id, id)),
    )
    .limit(1);
  if (!instance) return c.json({ error: 'instance not found' }, 404);

  let url: string;
  try {
    url = normalizeSeerrUrl(body.url);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'invalid URL' },
      400,
    );
  }
  const [duplicate] = await db
    .select({ id: seerrInstances.id })
    .from(seerrInstances)
    .where(
      and(
        eq(seerrInstances.serverId, serverId),
        eq(seerrInstances.url, url),
        ne(seerrInstances.id, id),
      ),
    )
    .limit(1);
  if (duplicate) {
    return c.json({ error: 'this Seerr instance is already configured' }, 409);
  }

  const apiKey = body.apiKey?.trim() || instance.apiKey;
  try {
    await new SeerrClient(url, apiKey).testConnection();
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : 'connection test failed',
      },
      502,
    );
  }

  const [updated] = await db
    .update(seerrInstances)
    .set({
      name: body.name.trim(),
      url,
      apiKey,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(
      and(eq(seerrInstances.serverId, serverId), eq(seerrInstances.id, id)),
    )
    .returning();
  return c.json(publicInstance(updated));
});

router.delete('/instances/:id', async (c) => {
  const serverId = c.get('activeServerId');
  const id = Number(c.req.param('id'));
  if (serverId === null || !Number.isInteger(id)) {
    return c.json({ error: 'instance not found' }, 404);
  }
  await db
    .delete(seerrInstances)
    .where(
      and(eq(seerrInstances.serverId, serverId), eq(seerrInstances.id, id)),
    );
  return c.json({ ok: true as const });
});

export default router;
