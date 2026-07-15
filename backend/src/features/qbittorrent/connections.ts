import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { qbittorrentInstances } from '../../db/schema.ts';
import {
  normalizeQbittorrentUrl,
  QbittorrentClient,
} from '../../integrations/qbittorrent/client.ts';

export interface QbittorrentTarget {
  instanceKey: string;
  instanceId: number | null;
  instanceName: string;
  client: QbittorrentClient;
}

export function envQbittorrentConfigured(): boolean {
  return Boolean(Deno.env.get('QBITTORRENT_URL')?.trim());
}

export async function getQbittorrentTargets(serverId: number): Promise<QbittorrentTarget[]> {
  const envUrl = Deno.env.get('QBITTORRENT_URL')?.trim();
  if (envUrl) {
    const normalized = normalizeQbittorrentUrl(envUrl);
    return [{
      instanceKey: `env:${normalized}`,
      instanceId: null,
      instanceName: 'qBittorrent (environment)',
      client: new QbittorrentClient(
        normalized,
        Deno.env.get('QBITTORRENT_USERNAME') ?? '',
        Deno.env.get('QBITTORRENT_PASSWORD') ?? '',
      ),
    }];
  }

  const rows = await db.select().from(qbittorrentInstances).where(
    eq(qbittorrentInstances.serverId, serverId),
  );
  return rows.map((row) => ({
    instanceKey: `db:${row.id}`,
    instanceId: row.id,
    instanceName: row.name,
    client: new QbittorrentClient(row.url, row.username, row.password),
  }));
}
