import { getQbittorrentTargets } from '../qbittorrent/connections.ts';
import type { DownloadClientTarget } from './downloadClient.ts';

/**
 * Compile-time provider registry for download clients.
 *
 * New providers add their target factory here; deletion planning remains unchanged.
 * Keeping registration explicit avoids runtime plugin loading in a destructive workflow.
 */
export async function getDownloadClientTargets(
  serverId: number,
): Promise<DownloadClientTarget[]> {
  const providers = await Promise.all([
    getQbittorrentTargets(serverId),
  ]);
  return providers.flat();
}
