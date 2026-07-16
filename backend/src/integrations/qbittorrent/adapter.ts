import type { DownloadClient, DownloadJob } from '../../features/mediaDeletion/downloadClient.ts';
import type { QbittorrentClient } from './client.ts';

/** Keeps qBittorrent hashes and API method names out of the deletion domain. */
export class QbittorrentDownloadClient implements DownloadClient {
  constructor(readonly client: QbittorrentClient) {}

  async findJob(downloadId: string): Promise<DownloadJob | null> {
    const torrent = await this.client.torrent(downloadId);
    return torrent ? { ...torrent, id: torrent.hash } : null;
  }

  deleteJob(downloadId: string, options: { deleteData: boolean }): Promise<void> {
    if (!options.deleteData) {
      throw new Error('qBittorrent cleanup requires explicit payload deletion');
    }
    return this.client.deleteTorrent(downloadId);
  }
}
