import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { settings } from '../db/schema.ts';
import type { PlexItem, PlexLibrary } from '../types/plex.ts';

export type { PlexItem, PlexLibrary };

interface PlexRawMetadata {
  ratingKey: string;
  title: string;
  type: string;
  thumb?: string;
  addedAt?: number;
  lastViewedAt?: number;
  viewCount?: number;
  duration?: number;
  year?: number;
  Media?: Array<{ Part?: Array<{ size?: number }> }>;
}

const ITEMS_PAGE_SIZE = 300;
const FETCH_CONCURRENCY = 8;

// Plex media type IDs used in ?type= filters on /library/sections/:key/all
export const PLEX_TYPE = { MOVIE: 1, SHOW: 2, SEASON: 3, EPISODE: 4, ARTIST: 8, ALBUM: 9, TRACK: 10 } as const;

export const PLEX_CLIENT_PRODUCT = 'Plex Librarian';
const PLEX_CLIENT_VERSION = '1.0.0';
const PLEX_CLIENT_PLATFORM = 'Web';

export function buildPlexHeaders(clientId?: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-Plex-Product': PLEX_CLIENT_PRODUCT,
    'X-Plex-Version': PLEX_CLIENT_VERSION,
    'X-Plex-Platform': PLEX_CLIENT_PLATFORM,
  };
  if (clientId) headers['X-Plex-Client-Identifier'] = clientId;
  if (token) headers['X-Plex-Token'] = token;
  return headers;
}

// Plex reports sizes as 32-bit signed integers. Values 2–4 GB wrap negative and are
// corrected here. Values ≥ 4 GB wrap back to a smaller positive number and cannot be
// recovered — fileSize will be under-reported for those items.
// Result is stored in kilobytes to keep values well within 32-bit range for @db/sqlite.
const normalizeSize = (s: number) => s < 0 ? s + 2 ** 32 : s;

function mapItems(raw: PlexRawMetadata[]): PlexItem[] {
  return raw.map((item) => {
    const parts = item.Media?.flatMap((m) => m.Part ?? []).filter((p) => p.size != null) ?? [];
    const bytes = parts.length > 0 ? parts.reduce((acc, p) => acc + normalizeSize(p.size!), 0) : null;
    const fileSize = bytes !== null ? Math.round(bytes / 1000) : null;
    return {
      ratingKey: item.ratingKey,
      title: item.title,
      type: item.type,
      thumb: item.thumb ?? null,
      addedAt: item.addedAt ?? null,
      lastViewedAt: item.lastViewedAt ?? null,
      viewCount: item.viewCount ?? 0,
      fileSize,
      duration: item.duration ?? null,
      year: item.year ?? null,
    };
  });
}

export class PlexClient {
  private readonly url: string;

  constructor(url: string, private readonly token: string, private readonly clientId?: string) {
    this.url = url.replace(/\/$/, '');
  }

  private async get<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
    const url = `${this.url}${path}`;
    const headers = { ...extraHeaders, ...buildPlexHeaders(this.clientId, this.token) };

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with 50% jitter: ~1s, ~2s
        const base = 1000 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, base + Math.random() * base * 0.5));
      }

      let res: Response;
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        // Timeouts mean the server is already struggling — don't compound it with retries.
        if (err instanceof DOMException && err.name === 'TimeoutError') throw err;
        lastError = err;
        continue;
      }

      if (res.ok) return await res.json() as T;
      res.body?.cancel();

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Plex ${res.status}: ${path}`);
        continue;
      }
      // 4xx (except 429): auth failure, not found, etc. — retrying won't help.
      throw new Error(`Plex ${res.status}: ${path}`);
    }

    throw lastError;
  }

  async libraries(): Promise<PlexLibrary[]> {
    const data = await this.get<{ MediaContainer: { Directory?: PlexLibrary[] } }>(
      '/library/sections',
    );
    return data.MediaContainer.Directory ?? [];
  }

  async hasPlexPass(): Promise<boolean> {
    const data = await this.get<{ MediaContainer: { myPlexSubscription?: number } }>('/');
    return !!data.MediaContainer.myPlexSubscription;
  }

  assetUrl(path: string): string {
    const url = new URL(`${this.url}${path}`);
    url.searchParams.set('X-Plex-Token', this.token);
    return url.toString();
  }

  resizedAssetUrl(path: string, opts: { width?: string; height?: string }): string {
    const params = new URLSearchParams({ url: this.assetUrl(path), 'X-Plex-Token': this.token, minSize: '1', upscale: '0' });
    if (opts.width) params.set('width', opts.width);
    if (opts.height) params.set('height', opts.height);
    return `${this.url}/photo/:/transcode?${params}`;
  }

  async *libraryItems(libraryKey: string, typeFilter?: number): AsyncGenerator<PlexItem[]> {
    const basePath = typeFilter !== undefined
      ? `/library/sections/${libraryKey}/all?type=${typeFilter}`
      : `/library/sections/${libraryKey}/all`;
    const fetchPage = (start: number) =>
      this.get<{ MediaContainer: { Metadata?: PlexRawMetadata[]; totalSize?: number } }>(
        basePath,
        {
          'X-Plex-Container-Start': String(start),
          'X-Plex-Container-Size': String(ITEMS_PAGE_SIZE),
        },
      );

    const first = await fetchPage(0);
    const firstPage = first.MediaContainer.Metadata ?? [];
    const total = first.MediaContainer.totalSize;

    if (total === undefined) {
      throw new Error(`Plex did not return totalSize for library ${libraryKey}`);
    }

    yield mapItems(firstPage);

    const remainingStarts: number[] = [];
    for (let s = ITEMS_PAGE_SIZE; s < total; s += ITEMS_PAGE_SIZE) {
      remainingStarts.push(s);
    }

    for (let i = 0; i < remainingStarts.length; i += FETCH_CONCURRENCY) {
      const batch = await Promise.all(
        remainingStarts.slice(i, i + FETCH_CONCURRENCY).map(fetchPage),
      );
      yield batch.flatMap((d) => mapItems(d.MediaContainer.Metadata ?? []));
    }
  }
}

export class PlexConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlexConfigError';
  }
}

let _cachedClient: PlexClient | null = null;

// Call after any credential change so the next request re-resolves from DB.
export function clearPlexClientCache(): void {
  _cachedClient = null;
}

export async function createPlexClient(): Promise<PlexClient> {
  if (_cachedClient) return _cachedClient;

  // Env vars take precedence — power users and Docker setups can skip OAuth.
  const envUrl = Deno.env.get('PLEX_URL');
  const envToken = Deno.env.get('PLEX_TOKEN');
  if (envUrl && envToken) {
    // Ensure the settings row exists so clientId is always sent with requests.
    await db.insert(settings).values({ id: 1, clientId: crypto.randomUUID() }).onConflictDoNothing();
    const [envRow] = await db.select({ clientId: settings.clientId })
      .from(settings).where(eq(settings.id, 1)).limit(1);
    _cachedClient = new PlexClient(envUrl, envToken, envRow!.clientId);
    return _cachedClient;
  }
  if (envUrl || envToken) {
    throw new PlexConfigError('Both PLEX_URL and PLEX_TOKEN must be set when using env var auth');
  }

  const [row] = await db.select({
    plexUrl: settings.plexUrl,
    plexToken: settings.plexToken,
    clientId: settings.clientId,
  }).from(settings).where(eq(settings.id, 1)).limit(1);

  if (!row?.plexUrl || !row?.plexToken) {
    throw new PlexConfigError('Plex is not configured — complete setup at /setup');
  }

  _cachedClient = new PlexClient(row.plexUrl, row.plexToken, row.clientId);
  return _cachedClient;
}
