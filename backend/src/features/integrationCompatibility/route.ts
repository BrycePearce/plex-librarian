import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { arrInstances, qbittorrentInstances, seerrInstances } from '../../db/schema.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import { ArrClient } from '../../integrations/arr/client.ts';
import { QbittorrentClient } from '../../integrations/qbittorrent/client.ts';
import { SeerrClient } from '../../integrations/seerr/client.ts';
import type {
  IntegrationCompatibilityCheck,
  IntegrationCompatibilityResponse,
} from '@plex-librarian/shared/types.ts';
import { assessArr, assessQbittorrent, compatibleSeerr, unreachable } from './assessment.ts';
import { normalizeQbittorrentUrl } from '../../integrations/qbittorrent/client.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

router.get('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);

  const envUrl = Deno.env.get('QBITTORRENT_URL')?.trim();

  const [arr, qbit, seerr] = await Promise.all([
    db.select().from(arrInstances).where(eq(arrInstances.serverId, serverId)),
    envUrl
      ? Promise.resolve([])
      : db.select().from(qbittorrentInstances).where(eq(qbittorrentInstances.serverId, serverId)),
    db.select().from(seerrInstances).where(eq(seerrInstances.serverId, serverId)),
  ]);

  const probes: Array<Promise<IntegrationCompatibilityCheck>> = [
    ...arr.map(async (instance) => {
      const identity = {
        key: `${instance.type}:${instance.id}`,
        instanceId: instance.id,
        kind: instance.type,
        name: instance.name,
      } as const;
      try {
        const result = await new ArrClient(instance.type, instance.url, instance.apiKey)
          .testConnection();
        return assessArr(identity, result.version);
      } catch (error) {
        return unreachable(identity, error);
      }
    }),
    ...qbit.map(async (instance) => {
      const identity = {
        key: `qbittorrent:${instance.id}`,
        instanceId: instance.id,
        kind: 'qbittorrent',
        name: instance.name,
      } as const;
      try {
        const result = await new QbittorrentClient(
          instance.url,
          instance.username,
          instance.password,
        )
          .testConnection();
        return assessQbittorrent(identity, result.version, result.apiVersion);
      } catch (error) {
        return unreachable(identity, error);
      }
    }),
    ...seerr.map(async (instance) => {
      const identity = {
        key: `seerr:${instance.id}`,
        instanceId: instance.id,
        kind: 'seerr',
        name: instance.name,
      } as const;
      try {
        const result = await new SeerrClient(instance.url, instance.apiKey).testConnection();
        return compatibleSeerr(identity, result.version);
      } catch (error) {
        return unreachable(identity, error);
      }
    }),
  ];

  if (envUrl) {
    const identity = {
      key: 'qbittorrent:env',
      instanceId: null,
      kind: 'qbittorrent',
      name: 'qBittorrent (environment)',
    } as const;
    probes.push((async () => {
      try {
        const normalized = normalizeQbittorrentUrl(envUrl);
        const result = await new QbittorrentClient(
          normalized,
          Deno.env.get('QBITTORRENT_USERNAME') ?? '',
          Deno.env.get('QBITTORRENT_PASSWORD') ?? '',
        ).testConnection();
        return assessQbittorrent(identity, result.version, result.apiVersion);
      } catch (error) {
        return unreachable(identity, error);
      }
    })());
  }

  return c.json(
    {
      checkedAt: Math.floor(Date.now() / 1000),
      checks: await Promise.all(probes),
    } satisfies IntegrationCompatibilityResponse,
  );
});

export default router;
