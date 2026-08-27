export interface QbittorrentTorrent {
  hash: string;
  name: string;
  state: string;
  size: number;
  uploaded: number;
  ratio: number;
  seedingTime: number;
  completedAt: number | null;
  contentPath: string;
  savePath: string;
  trackerHost: string | null;
  fileCount: number;
  files: Array<{ path: string; size: number | null }>;
  filesTruncated: boolean;
  /** Complete manifest used internally for path ownership checks. */
  manifestFiles: Array<{ path: string; size: number | null }>;
  manifestByteSize: number;
}

export interface QbittorrentDiscoverySummary {
  hash: string;
  contentPath: string;
  savePath: string;
  size: number;
}

const PUBLIC_FILE_LIMIT = 100;
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const MANIFEST_MAX_RECORDS = 10_000;
export const QBITTORRENT_DISCOVERY_MAX_JOBS = 500;
const DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;

export class QbittorrentApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function normalizeQbittorrentUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  // Credentials have dedicated fields and are intentionally omitted from every
  // public connection response. Accepting URL userinfo would put them back into
  // the serialized URL shown by the settings API and UI.
  if (parsed.username || parsed.password) {
    throw new Error('URL must not include a username or password');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/$/, '').replace(/\/api\/v2$/i, '');
  return parsed.toString().replace(/\/$/, '');
}

function trackerHost(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return new URL(raw).hostname || null;
  } catch {
    return null;
  }
}

interface ValidatedTorrentSummary {
  hash: string;
  size: number;
  totalSize: number;
  contentPath: string;
  savePath: string;
}

function validateTorrentSummary(
  record: Record<string, unknown>,
  requestedHash: string,
): ValidatedTorrentSummary {
  const rawReturnedHash = record['hash'];
  const returnedHash = typeof rawReturnedHash === 'string' ? rawReturnedHash.toLowerCase() : '';
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(returnedHash) ||
    returnedHash !== requestedHash
  ) {
    throw new QbittorrentApiError('qBittorrent returned a nonmatching torrent identity');
  }
  const size = record['size'];
  const totalSize = record['total_size'];
  if (
    typeof totalSize !== 'number' || !Number.isSafeInteger(totalSize) || totalSize <= 0 ||
    typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > totalSize
  ) {
    throw new QbittorrentApiError('qBittorrent returned a malformed torrent size');
  }
  const rawContentPath = record['content_path'];
  const rawSavePath = record['save_path'];
  if (
    typeof rawContentPath !== 'string' || typeof rawSavePath !== 'string' ||
    !normalizeQbittorrentAbsolute(rawContentPath) ||
    !normalizeQbittorrentAbsolute(rawSavePath)
  ) {
    throw new QbittorrentApiError('qBittorrent returned malformed torrent storage paths');
  }
  return {
    hash: returnedHash,
    size,
    totalSize,
    contentPath: rawContentPath.trim(),
    savePath: rawSavePath.trim(),
  };
}

function torrentSummaryIdentity(summary: ValidatedTorrentSummary): string {
  return JSON.stringify(summary);
}

export class QbittorrentClient {
  private readonly baseUrl: string;
  private accessReady = false;
  private sessionCookie: string | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(
    url: string,
    private readonly username: string,
    private readonly password: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizeQbittorrentUrl(url);
  }

  private async ensureAccess(): Promise<void> {
    if (this.accessReady) return;
    if (this.loginPromise) return await this.loginPromise;
    this.loginPromise = (async () => {
      // qBittorrent can bypass WebUI authentication for loopback or explicitly
      // whitelisted subnets. Probe a harmless endpoint first so those installations
      // can be configured without inventing credentials or requiring an SID cookie.
      try {
        const probe = await this.fetchImpl(`${this.baseUrl}/api/v2/app/version`, {
          headers: { 'Referer': `${this.baseUrl}/` },
          signal: AbortSignal.timeout(15_000),
        });
        if (probe.ok) {
          this.accessReady = true;
          return;
        }
      } catch (error) {
        throw new QbittorrentApiError(
          `qBittorrent is unreachable: ${
            error instanceof Error ? error.message : 'request failed'
          }`,
        );
      }

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/api/v2/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': `${this.baseUrl}/`,
          },
          body: new URLSearchParams({ username: this.username, password: this.password }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        throw new QbittorrentApiError(
          `qBittorrent is unreachable: ${
            error instanceof Error ? error.message : 'request failed'
          }`,
        );
      }
      if (!response.ok) {
        throw new QbittorrentApiError(
          `qBittorrent login failed${response.status ? ` (${response.status})` : ''}`,
          response.status,
        );
      }
      // Success has changed from `200 Ok.` to `204 No Content` across qBittorrent
      // versions. Accept any 2xx response, but require the session cookie that
      // proves authentication succeeded instead of trusting status or body alone.
      const setCookie = response.headers.get('set-cookie') ?? '';
      const sid = setCookie.split(';', 1)[0]?.trim();
      if (!sid) {
        throw new QbittorrentApiError(
          'qBittorrent login failed: no session cookie returned',
          response.status,
        );
      }
      this.sessionCookie = sid;
      this.accessReady = true;
    })();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    parse: 'json' | 'text' = 'json',
    maxBytes?: number,
  ): Promise<T> {
    await this.ensureAccess();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v2${path}`, {
        ...init,
        headers: {
          'Referer': `${this.baseUrl}/`,
          ...(this.sessionCookie ? { 'Cookie': this.sessionCookie } : {}),
          ...init?.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new QbittorrentApiError(
        `qBittorrent is unreachable: ${error instanceof Error ? error.message : 'request failed'}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      this.accessReady = false;
      this.sessionCookie = null;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new QbittorrentApiError(
        `qBittorrent returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        response.status,
      );
    }
    let text: string;
    if (maxBytes === undefined) {
      text = await response.text();
    } else {
      if (!response.body) throw new QbittorrentApiError('qBittorrent returned an empty response');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new QbittorrentApiError(
            `qBittorrent response exceeded the ${maxBytes}-byte safety limit`,
          );
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      text = new TextDecoder().decode(bytes);
    }
    if (parse === 'text') return text as T;
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async testConnection(): Promise<{ version: string }> {
    const version = await this.request<string>('/app/version', undefined, 'text');
    return { version: version.trim() };
  }

  async torrent(hash: string): Promise<QbittorrentTorrent | null> {
    const normalizedHash = hash.trim().toLowerCase();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(normalizedHash)) {
      throw new QbittorrentApiError('qBittorrent torrent lookup requires an exact torrent hash');
    }
    const records = await this.request<Array<Record<string, unknown>>>(
      `/torrents/info?hashes=${encodeURIComponent(normalizedHash)}`,
    );
    if (!Array.isArray(records) || records.length > 1) {
      throw new QbittorrentApiError('qBittorrent returned an ambiguous torrent identity');
    }
    const record = records[0];
    if (!record) return null;
    const firstSummary = validateTorrentSummary(record, normalizedHash);
    const files = await this.request<Array<Record<string, unknown>>>(
      `/torrents/files?hash=${encodeURIComponent(normalizedHash)}`,
      undefined,
      'json',
      MANIFEST_MAX_BYTES,
    );
    if (!Array.isArray(files) || files.length === 0) {
      throw new QbittorrentApiError('qBittorrent returned a malformed torrent manifest');
    }
    if (files.length > MANIFEST_MAX_RECORDS) {
      throw new QbittorrentApiError(
        `qBittorrent manifest exceeded the ${MANIFEST_MAX_RECORDS}-record safety limit`,
      );
    }
    const completed = Number(record['completion_on']);
    let manifestTotalSize = 0;
    const manifestFiles = files.map((file, position) => {
      const index = file['index'];
      const path = file['name'];
      const size = file['size'];
      if (
        typeof index !== 'number' || !Number.isSafeInteger(index) || index !== position ||
        typeof path !== 'string' || path !== path.trim() ||
        typeof size !== 'number'
      ) {
        throw new QbittorrentApiError('qBittorrent returned a malformed torrent manifest');
      }
      const parts = path.split(/[\\/]+/);
      if (
        !path || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') ||
        parts.some((part) => !part || part === '.' || part === '..') ||
        !Number.isSafeInteger(size) || size < 0
      ) {
        throw new QbittorrentApiError('qBittorrent returned a malformed torrent manifest');
      }
      if (!Number.isSafeInteger(manifestTotalSize + size)) {
        throw new QbittorrentApiError('qBittorrent returned a malformed torrent manifest');
      }
      manifestTotalSize += size;
      return { path: parts.join('/'), size };
    });
    const manifestPaths = manifestFiles.map((file) => file.path.toLocaleLowerCase('en-US'));
    const uniquePaths = new Set(manifestPaths);
    const conflicting = manifestPaths.some((path) => {
      const parts = path.split('/');
      return parts.slice(1).some((_, index) =>
        uniquePaths.has(parts.slice(0, index + 1).join('/'))
      );
    });
    if (uniquePaths.size !== manifestPaths.length || conflicting) {
      throw new QbittorrentApiError('qBittorrent returned a conflicting torrent manifest');
    }
    if (manifestTotalSize !== firstSummary.totalSize) {
      throw new QbittorrentApiError('qBittorrent returned an incomplete torrent manifest');
    }
    const afterRecords = await this.request<Array<Record<string, unknown>>>(
      `/torrents/info?hashes=${encodeURIComponent(normalizedHash)}`,
    );
    if (!Array.isArray(afterRecords) || afterRecords.length !== 1) {
      throw new QbittorrentApiError('qBittorrent torrent identity changed during manifest read');
    }
    const secondSummary = validateTorrentSummary(afterRecords[0]!, normalizedHash);
    if (torrentSummaryIdentity(firstSummary) !== torrentSummaryIdentity(secondSummary)) {
      throw new QbittorrentApiError('qBittorrent torrent identity changed during manifest read');
    }
    return {
      hash: firstSummary.hash,
      name: String(record['name'] ?? normalizedHash),
      state: String(record['state'] ?? 'unknown'),
      size: firstSummary.size,
      uploaded: Number(record['uploaded'] ?? 0),
      ratio: Number(record['ratio'] ?? 0),
      seedingTime: Number(record['seeding_time'] ?? 0),
      completedAt: Number.isFinite(completed) && completed > 0 ? completed : null,
      contentPath: firstSummary.contentPath,
      savePath: firstSummary.savePath,
      trackerHost: trackerHost(record['tracker']),
      fileCount: manifestFiles.length,
      files: manifestFiles.slice(0, PUBLIC_FILE_LIMIT),
      filesTruncated: files.length > PUBLIC_FILE_LIMIT,
      manifestFiles,
      manifestByteSize: new TextEncoder().encode(JSON.stringify(files)).byteLength,
    };
  }

  async discoverySummaries(): Promise<QbittorrentDiscoverySummary[]> {
    const records = await this.request<Array<Record<string, unknown>>>(
      `/torrents/info?limit=${QBITTORRENT_DISCOVERY_MAX_JOBS + 1}`,
      undefined,
      'json',
      DISCOVERY_MAX_BYTES,
    );
    if (!Array.isArray(records) || records.length > QBITTORRENT_DISCOVERY_MAX_JOBS) {
      throw new QbittorrentApiError('qBittorrent direct discovery is truncated');
    }
    const summaries = records.map((record) => ({
      hash: String(record.hash ?? '').trim().toLowerCase(),
      contentPath: String(record.content_path ?? '').trim(),
      savePath: String(record.save_path ?? '').trim(),
      size: Number(record.size),
    })).sort((left, right) => left.hash.localeCompare(right.hash));
    if (
      summaries.some((summary) =>
        !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(summary.hash) ||
        !normalizeQbittorrentAbsolute(summary.contentPath) ||
        !normalizeQbittorrentAbsolute(summary.savePath) ||
        !Number.isSafeInteger(summary.size) || summary.size < 0
      ) || new Set(summaries.map((summary) => summary.hash)).size !== summaries.length
    ) {
      throw new QbittorrentApiError('qBittorrent returned malformed direct-discovery summaries');
    }
    return summaries;
  }

  async discoveryHashes(): Promise<string[]> {
    return (await this.discoverySummaries()).map((summary) => summary.hash);
  }

  async deleteTorrent(hash: string): Promise<void> {
    await this.request<void>('/torrents/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: hash, deleteFiles: 'true' }),
    });
    // qBittorrent returns 200 even for some no-op cases. Confirm that the job really
    // disappeared before allowing Arr to remove the final library hardlink.
    if (await this.torrent(hash)) {
      throw new QbittorrentApiError('qBittorrent still reports the torrent after deletion');
    }
  }
}

function normalizeQbittorrentAbsolute(path: string): boolean {
  const value = path.trim();
  return value.startsWith('/') && !value.includes('\\') &&
      !value.split('/').some((segment) => segment === '..') ||
    /^[A-Za-z]:[\\/]/.test(value) && !value.split(/[\\/]/).some((segment) => segment === '..');
}
