import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { qbittorrentInstances } from '../../db/schema.ts';
import {
  normalizeQbittorrentUrl,
  QbittorrentClient,
} from '../../integrations/qbittorrent/client.ts';
import { QbittorrentDownloadClient } from '../../integrations/qbittorrent/adapter.ts';
import type { DownloadClientTarget } from '../mediaDeletion/downloadClient.ts';

export function envQbittorrentConfigured(): boolean {
  return Boolean(Deno.env.get('QBITTORRENT_URL')?.trim());
}

export async function getQbittorrentTargets(serverId: number): Promise<DownloadClientTarget[]> {
  const envUrl = Deno.env.get('QBITTORRENT_URL')?.trim();
  if (envUrl) {
    const normalized = normalizeQbittorrentUrl(envUrl);
    return [{
      provider: 'qbittorrent',
      instanceKey: `env:${normalized}`,
      instanceId: null,
      instanceName: 'qBittorrent (environment)',
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
  return rows.map((row) => ({
    provider: 'qbittorrent',
    instanceKey: `db:${row.id}`,
    instanceId: row.id,
    instanceName: row.name,
    client: new QbittorrentDownloadClient(
      new QbittorrentClient(row.url, row.username, row.password),
    ),
  }));
}
