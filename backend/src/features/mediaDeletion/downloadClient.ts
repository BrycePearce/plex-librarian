/**
 * Provider-neutral view of a download job used by deletion planning.
 *
 * Adapters must expose a complete manifest before the core workflow will authorize
 * payload deletion. Provider-specific identifiers (torrent hashes, queue IDs, etc.)
 * are normalized to `id` and remain opaque to this feature.
 */
export interface DownloadJob {
  id: string;
  name: string;
  state: string;
  size: number;
  uploaded: number;
  completedAt: number | null;
  ratio: number | null;
  seedingTime: number;
  contentPath: string;
  savePath: string;
  trackerHost: string | null;
  fileCount: number;
  files: Array<{ path: string; size: number | null }>;
  filesTruncated: boolean;
  manifestFiles: Array<{ path: string; size: number | null }>;
}

export interface DownloadClient {
  findJob(downloadId: string): Promise<DownloadJob | null>;
  deleteJob(downloadId: string, options: { deleteData: boolean }): Promise<void>;
}

export interface DownloadClientTarget {
  provider: string;
  instanceKey: string;
  instanceId: number | null;
  instanceName: string;
  client: DownloadClient;
}
