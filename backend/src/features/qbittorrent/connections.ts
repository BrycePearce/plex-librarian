import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { qbittorrentInstances, qbittorrentPathMappings } from '../../db/schema.ts';
import {
  normalizeQbittorrentUrl,
  QbittorrentClient,
} from '../../integrations/qbittorrent/client.ts';
import { QbittorrentDownloadClient } from '../../integrations/qbittorrent/adapter.ts';
import type { DownloadClientTarget } from '../mediaDeletion/downloadClient.ts';

export function envQbittorrentConfigured(): boolean {
  return Boolean(Deno.env.get('QBITTORRENT_URL')?.trim());
}

export async function qbittorrentConfigured(serverId: number): Promise<boolean> {
  if (envQbittorrentConfigured()) return true;
  const [row] = await db.select({ id: qbittorrentInstances.id }).from(qbittorrentInstances).where(
    eq(qbittorrentInstances.serverId, serverId),
  ).limit(1);
  return row !== undefined;
}

export async function getQbittorrentTargets(serverId: number): Promise<DownloadClientTarget[]> {
  const allMappings = await db.select().from(qbittorrentPathMappings).where(
    eq(qbittorrentPathMappings.serverId, serverId),
  );
  const mappingFor = (instanceKey: string) =>
    allMappings.filter((mapping) => mapping.instanceKey === instanceKey).map((mapping) => ({
      id: mapping.id,
      qbittorrentPath: mapping.qbittorrentPath,
      localPath: mapping.localPath,
      caseSensitive: mapping.caseSensitive,
      revision: mapping.revision,
    })).sort((left, right) => left.id - right.id);
  const envUrl = Deno.env.get('QBITTORRENT_URL')?.trim();
  if (envUrl) {
    const normalized = normalizeQbittorrentUrl(envUrl);
    const instanceKey = `env:${normalized}`;
    const pathMappings = mappingFor(instanceKey);
    return [{
      provider: 'qbittorrent',
      instanceKey,
      instanceUrl: normalized,
      configurationIdentity: `env:${normalized}:${JSON.stringify(pathMappings)}`,
      instanceId: null,
      instanceName: 'qBittorrent (environment)',
      pathMappings,
      client: new QbittorrentDownloadClient(
        new QbittorrentClient(
          normalized,
          Deno.env.get('QBITTORRENT_USERNAME') ?? '',
          Deno.env.get('QBITTORRENT_PASSWORD') ?? '',
        ),
      ),
    }];
  }

  const rows = await db.select().from(qbittorrentInstances).where(
    eq(qbittorrentInstances.serverId, serverId),
  );
  return rows.map((row) => {
    const instanceKey = `db:${row.id}`;
    const pathMappings = mappingFor(instanceKey);
    return {
      provider: 'qbittorrent',
      instanceKey,
      instanceUrl: normalizeQbittorrentUrl(row.url),
      configurationIdentity: `db:${row.id}:${row.updatedAt}:${normalizeQbittorrentUrl(row.url)}:${
        JSON.stringify(pathMappings)
      }`,
      instanceId: row.id,
      instanceName: row.name,
      pathMappings,
      client: new QbittorrentDownloadClient(
        new QbittorrentClient(row.url, row.username, row.password),
      ),
    };
  });
}
