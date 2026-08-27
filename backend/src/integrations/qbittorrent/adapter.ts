import type {
  DiscoveredDownloadJobs,
  DownloadClient,
  DownloadDiscoveryCandidate,
  DownloadJob,
} from '../../features/mediaDeletion/downloadClient.ts';
import { normalizeRemoteAbsolute } from '../../features/mediaDeletion/hardlinks.ts';
import type { QbittorrentClient } from './client.ts';

const DISCOVERY_MANIFEST_MAX_RECORDS = 25_000;
const DISCOVERY_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const DISCOVERY_MANIFEST_CONCURRENCY = 6;

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= values.length) return;
        results[index] = await map(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function summaryIdentity(value: unknown): string {
  return JSON.stringify(value);
}

async function summaryFingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(summaryIdentity(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function within(path: string, root: string, caseSensitive: boolean): boolean {
  const candidate = caseSensitive ? path : path.toLocaleLowerCase('en-US');
  const prefix = caseSensitive ? root : root.toLocaleLowerCase('en-US');
  const separator = prefix.includes('\\') ? '\\' : '/';
  return candidate === prefix || candidate.startsWith(`${prefix}${separator}`);
}

function couldOwnCandidate(
  summary: { contentPath: string },
  candidates: readonly DownloadDiscoveryCandidate[],
): boolean {
  const content = normalizeRemoteAbsolute(summary.contentPath);
  if (!content) return false;
  return candidates.some((candidate) => {
    const path = normalizeRemoteAbsolute(candidate.path);
    if (!path || path.separator !== content.separator) return false;
    return within(path.path, content.path, candidate.caseSensitive);
  });
}

/** Keeps qBittorrent hashes and API method names out of the deletion domain. */
export class QbittorrentDownloadClient implements DownloadClient {
  constructor(readonly client: QbittorrentClient) {}

  async findJob(downloadId: string): Promise<DownloadJob | null> {
    const torrent = await this.client.torrent(downloadId);
    return torrent ? { ...torrent, id: torrent.hash } : null;
  }

  async discoverJobs(
    candidates: readonly DownloadDiscoveryCandidate[],
  ): Promise<DiscoveredDownloadJobs> {
    if (candidates.length === 0) {
      throw new Error('qBittorrent direct discovery requires an exact candidate path');
    }
    const first = (await this.client.discoverySummaries()).filter((summary) =>
      couldOwnCandidate(summary, candidates)
    );
    let manifestRecords = 0;
    let manifestBytes = 0;
    const jobs = await mapWithConcurrency(
      first,
      DISCOVERY_MANIFEST_CONCURRENCY,
      async (summary): Promise<DownloadJob> => {
        const torrent = await this.client.torrent(summary.hash);
        if (!torrent) throw new Error('qBittorrent jobs changed during direct discovery');
        const liveSummary = {
          hash: torrent.hash,
          contentPath: torrent.contentPath,
          savePath: torrent.savePath,
          size: torrent.size,
        };
        if (summaryIdentity(summary) !== summaryIdentity(liveSummary)) {
          throw new Error('qBittorrent ownership summaries changed during direct discovery');
        }
        manifestRecords += torrent.manifestFiles.length;
        manifestBytes += torrent.manifestByteSize;
        if (
          manifestRecords > DISCOVERY_MANIFEST_MAX_RECORDS ||
          manifestBytes > DISCOVERY_MANIFEST_MAX_BYTES
        ) {
          throw new Error('qBittorrent direct discovery exceeded its shared manifest budget');
        }
        return { ...torrent, id: torrent.hash };
      },
    );
    const second = (await this.client.discoverySummaries()).filter((summary) =>
      couldOwnCandidate(summary, candidates)
    );
    if (summaryIdentity(first) !== summaryIdentity(second)) {
      throw new Error('qBittorrent ownership summaries changed during direct discovery');
    }
    return { jobs, summaryFingerprint: await summaryFingerprint(first) };
  }

  deleteJob(downloadId: string, options: { deleteData: boolean }): Promise<void> {
    if (!options.deleteData) {
      throw new Error('qBittorrent cleanup requires explicit payload deletion');
    }
    return this.client.deleteTorrent(downloadId);
  }
}
