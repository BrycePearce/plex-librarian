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
  /** Approximate serialized manifest bytes retained by the adapter for aggregate budgeting. */
  manifestByteSize?: number;
}

export interface DiscoveredDownloadJobs {
  jobs: DownloadJob[];
  /** Stable identity of every candidate summary observed around manifest reads. */
  summaryFingerprint: string;
}

export interface DownloadDiscoveryCandidate {
  path: string;
  caseSensitive: boolean;
}

export interface DownloadClient {
  findJob(downloadId: string): Promise<DownloadJob | null>;
  discoverJobs?(
    candidates: readonly DownloadDiscoveryCandidate[],
  ): Promise<DiscoveredDownloadJobs>;
  deleteJob(downloadId: string, options: { deleteData: boolean }): Promise<void>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => JSON.stringify(key) + ':' + stableJson(child))
        .join(',') +
      '}';
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function downloadJobSummaryFingerprint(job: DownloadJob): Promise<string> {
  return sha256({
    id: job.id,
    contentPath: job.contentPath,
    savePath: job.savePath,
    size: job.size,
    fileCount: job.fileCount,
  });
}

export function downloadJobManifestFingerprint(job: DownloadJob): Promise<string> {
  return sha256(
    [...job.manifestFiles]
      .map((file) => ({ path: file.path, size: file.size }))
      .sort((left, right) =>
        left.path.localeCompare(right.path) || (left.size ?? -1) - (right.size ?? -1)
      ),
  );
}

export interface DownloadClientTarget {
  provider: string;
  instanceKey: string;
  /** User-facing Web UI root. It contains no credentials and is safe to return in previews. */
  instanceUrl?: string;
  /** Stable, non-secret identity for the exact configured endpoint accepted by preview. */
  configurationIdentity: string;
  instanceId: number | null;
  instanceName: string;
  pathMappings?: Array<{
    id: number;
    qbittorrentPath: string;
    localPath: string;
    caseSensitive: boolean;
    revision: number;
  }>;
  client: DownloadClient;
}
