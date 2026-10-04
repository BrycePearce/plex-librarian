import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { arrInstances, qbittorrentInstances, seerrInstances } from '../../db/schema.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import { ArrClient } from '../../integrations/arr/client.ts';
import {
  normalizeQbittorrentUrl,
  QbittorrentClient,
} from '../../integrations/qbittorrent/client.ts';
import { SeerrClient } from '../../integrations/seerr/client.ts';
import type {
  IntegrationCompatibilityCheck,
  IntegrationCompatibilityResponse,
} from '@plex-librarian/shared/types.ts';
import { assessArr, assessQbittorrent, compatibleSeerr, unreachable } from './assessment.ts';
import { compatibilityCache } from './cache.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

router.get('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'Plex is not configured' }, 409);

  const envUrl = Deno.env.get('QBITTORRENT_URL')?.trim();

  // Read current configuration every time so edits, removals, and environment overrides
  // take effect immediately, including credential changes within the same second.
  const [arr, qbit, seerr] = await Promise.all([
    db.select().from(arrInstances).where(eq(arrInstances.serverId, serverId)),
    envUrl
      ? Promise.resolve([])
      : db.select().from(qbittorrentInstances).where(eq(qbittorrentInstances.serverId, serverId)),
    db.select().from(seerrInstances).where(eq(seerrInstances.serverId, serverId)),
  ]);

  const cachedProbe = (
    identity: Pick<IntegrationCompatibilityCheck, 'key' | 'instanceId' | 'kind' | 'name'>,
    configuration: readonly unknown[],
    probe: () => Promise<IntegrationCompatibilityCheck>,
  ) =>
    compatibilityCache.get(serverId, identity.key, [identity, ...configuration], async () => {
      try {
        return await probe();
      } catch (error) {
        return unreachable(identity, error);
      }
    });

  const probes = [
    ...arr.map((instance) => {
      const identity = {
        key: `${instance.type}:${instance.id}`,
        instanceId: instance.id,
        kind: instance.type,
        name: instance.name,
      } as const;
      return cachedProbe(identity, [instance.url, instance.apiKey], async () => {
        const result = await new ArrClient(instance.type, instance.url, instance.apiKey)
          .testConnection();
        return assessArr(identity, result.version);
      });
    }),
    ...qbit.map((instance) => {
      const identity = {
        key: `qbittorrent:${instance.id}`,
        instanceId: instance.id,
        kind: 'qbittorrent',
        name: instance.name,
      } as const;
      return cachedProbe(
        identity,
        [instance.url, instance.username, instance.password],
        async () => {
          const result = await new QbittorrentClient(
            instance.url,
            instance.username,
            instance.password,
          ).testConnection();
          return assessQbittorrent(identity, result.version, result.apiVersion);
        },
      );
    }),
    ...seerr.map((instance) => {
      const identity = {
        key: `seerr:${instance.id}`,
        instanceId: instance.id,
        kind: 'seerr',
        name: instance.name,
      } as const;
      return cachedProbe(identity, [instance.url, instance.apiKey], async () => {
        const result = await new SeerrClient(instance.url, instance.apiKey).testConnection();
        return compatibleSeerr(identity, result.version);
      });
    }),
  ];

  if (envUrl) {
    const identity = {
      key: 'qbittorrent:env',
      instanceId: null,
      kind: 'qbittorrent',
      name: 'qBittorrent (environment)',
    } as const;
    const username = Deno.env.get('QBITTORRENT_USERNAME') ?? '';
    const password = Deno.env.get('QBITTORRENT_PASSWORD') ?? '';
    probes.push(cachedProbe(identity, [envUrl, username, password], async () => {
      const result = await new QbittorrentClient(
        normalizeQbittorrentUrl(envUrl),
        username,
        password,
      ).testConnection();
      return assessQbittorrent(identity, result.version, result.apiVersion);
    }));
  }

  const results = await Promise.all(probes);
  return c.json(
    {
      checkedAt: results.length
        ? Math.min(...results.map((result) => result.checkedAt))
        : Math.floor(Date.now() / 1000),
      checks: results.map((result) => result.check),
    } satisfies IntegrationCompatibilityResponse,
  );
});

export default router;
