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
}

const PUBLIC_FILE_LIMIT = 100;

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
      const text = await response.text();
      if (!response.ok || text.trim() !== 'Ok.') {
        throw new QbittorrentApiError(
          `qBittorrent login failed${response.status ? ` (${response.status})` : ''}`,
          response.status,
        );
      }
      const setCookie = response.headers.get('set-cookie') ?? '';
      const sid = setCookie.split(';', 1)[0]?.trim();
      if (!sid) throw new QbittorrentApiError('qBittorrent did not return a session cookie');
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
    if (parse === 'text') return await response.text() as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async testConnection(): Promise<{ version: string }> {
    const version = await this.request<string>('/app/version', undefined, 'text');
    return { version: version.trim() };
  }

  async torrent(hash: string): Promise<QbittorrentTorrent | null> {
    const records = await this.request<Array<Record<string, unknown>>>(
      `/torrents/info?hashes=${encodeURIComponent(hash)}`,
    );
    const record = records[0];
    if (!record) return null;
    const files = await this.request<Array<Record<string, unknown>>>(
      `/torrents/files?hash=${encodeURIComponent(hash)}`,
    );
    const completed = Number(record['completion_on']);
    return {
      hash: String(record['hash'] ?? hash).toLowerCase(),
      name: String(record['name'] ?? hash),
      state: String(record['state'] ?? 'unknown'),
      size: Number(record['size'] ?? record['total_size'] ?? 0),
      uploaded: Number(record['uploaded'] ?? 0),
      ratio: Number(record['ratio'] ?? 0),
      seedingTime: Number(record['seeding_time'] ?? 0),
      completedAt: Number.isFinite(completed) && completed > 0 ? completed : null,
      contentPath: String(record['content_path'] ?? ''),
      savePath: String(record['save_path'] ?? ''),
      trackerHost: trackerHost(record['tracker']),
      fileCount: files.length,
      files: files.slice(0, PUBLIC_FILE_LIMIT).flatMap((file) => {
        const path = String(file['name'] ?? '').trim();
        if (!path) return [];
        const size = Number(file['size']);
        return [{ path, size: Number.isFinite(size) && size >= 0 ? size : null }];
      }),
      filesTruncated: files.length > PUBLIC_FILE_LIMIT,
    };
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
