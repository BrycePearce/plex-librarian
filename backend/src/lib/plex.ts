import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { servers, settings } from '../db/schema.ts';

export interface PlexLibrary {
  key: string;
  title: string;
  type: string;
}

export interface PlexItem {
  ratingKey: string;
  title: string;
  type: string;
  thumb: string | null;
  addedAt: number | null;
  lastViewedAt: number | null;
  viewCount: number;
  fileSize: number | null;
  duration: number | null;
  year: number | null;
}

export interface PlexWebhookPayload {
  event: string;
  user: boolean;
  owner: boolean;
  Account: { id: number; title: string };
  Server: { title: string; uuid: string };
  Player: { local: boolean; publicAddress: string; title: string; uuid: string };
  Metadata?: {
    librarySectionType: string;
    ratingKey: string;
    type: string;
    title: string;
    grandparentRatingKey?: string; // show ratingKey when type === 'episode'
    viewCount?: number;
    lastViewedAt?: number;
  };
}

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
  // Episode-level parent references — only present on type=4 responses.
  parentRatingKey?: string; // season ratingKey
  parentIndex?: number; // season number
  parentTitle?: string; // season title
  grandparentRatingKey?: string; // show ratingKey
  Media?: Array<{ Part?: Array<{ size?: number }> }>;
}

// Minimal episode shape used by syncShowSizes to aggregate season file sizes.
// Not exposed via API — purely internal to the sync pipeline.
export interface PlexEpisode {
  ratingKey: string;
  seasonRatingKey: string;
  showRatingKey: string;
  seasonIndex: number;
  seasonTitle: string;
  fileSize: number | null;
  duration: number | null;
  viewCount: number;
}

// Minimal track shape used by syncArtistSizes to aggregate artist file sizes.
// Not exposed via API — purely internal to the sync pipeline.
export interface PlexTrack {
  ratingKey: string;
  artistRatingKey: string;
  fileSize: number | null;
}

// History entry returned by /status/sessions/history/all — cross-user, all accounts.
// grandparentKey is a path ("/library/metadata/76749"), not a bare ratingKey.
interface PlexHistoryEntry {
  ratingKey: string;
  grandparentKey?: string; // "/library/metadata/<showRatingKey>" when type === 'episode'
  viewedAt?: number;
}

const ITEMS_PAGE_SIZE = 300;
// Max concurrent page-fetch requests per library. Override via FETCH_CONCURRENCY env var.
const FETCH_CONCURRENCY = Math.max(1, parseInt(Deno.env.get('FETCH_CONCURRENCY') ?? '', 10) || 8);

// Plex media type IDs used in ?type= filters on /library/sections/:key/all
export const PLEX_TYPE = {
  MOVIE: 1,
  SHOW: 2,
  SEASON: 3,
  EPISODE: 4,
  ARTIST: 8,
  ALBUM: 9,
  TRACK: 10,
} as const;

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

function extractFileSize(item: PlexRawMetadata): number | null {
  const parts = item.Media?.flatMap((m) => m.Part ?? []).filter((p) => p.size != null) ?? [];
  if (parts.length === 0) return null;
  const bytes = parts.reduce((acc, p) => acc + normalizeSize(p.size!), 0);
  return Math.round(bytes / 1000);
}

function mapItems(raw: PlexRawMetadata[]): PlexItem[] {
  return raw.map((item) => ({
    ratingKey: item.ratingKey,
    title: item.title,
    type: item.type,
    thumb: item.thumb ?? null,
    addedAt: item.addedAt ?? null,
    lastViewedAt: item.lastViewedAt ?? null,
    viewCount: item.viewCount ?? 0,
    fileSize: extractFileSize(item),
    duration: item.duration ?? null,
    year: item.year ?? null,
  }));
}

function mapTracks(raw: PlexRawMetadata[]): PlexTrack[] {
  return raw
    .filter((item) => item.grandparentRatingKey)
    .map((item) => ({
      ratingKey: item.ratingKey,
      artistRatingKey: item.grandparentRatingKey!,
      fileSize: extractFileSize(item),
    }));
}

function mapEpisodes(raw: PlexRawMetadata[]): PlexEpisode[] {
  return raw
    .filter((item) => item.parentRatingKey && item.grandparentRatingKey && item.parentIndex != null)
    .map((item) => ({
      ratingKey: item.ratingKey,
      seasonRatingKey: item.parentRatingKey!,
      showRatingKey: item.grandparentRatingKey!,
      seasonIndex: item.parentIndex!,
      seasonTitle: item.parentTitle ?? `Season ${item.parentIndex}`,
      fileSize: extractFileSize(item),
      duration: item.duration ?? null,
      viewCount: item.viewCount ?? 0,
    }));
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

  // Stable per-install identifier for the PMS itself — used to detect when
  // PLEX_URL/PLEX_TOKEN now point at a different server than before.
  async identity(): Promise<string> {
    const data = await this.get<{ MediaContainer: { machineIdentifier: string } }>('/identity');
    return data.MediaContainer.machineIdentifier;
  }

  assetUrl(path: string): string {
    const url = new URL(`${this.url}${path}`);
    url.searchParams.set('X-Plex-Token', this.token);
    return url.toString();
  }

  resizedAssetUrl(path: string, opts: { width?: string; height?: string }): string {
    const params = new URLSearchParams({
      url: this.assetUrl(path),
      'X-Plex-Token': this.token,
      minSize: '1',
      upscale: '0',
    });
    if (opts.width) params.set('width', opts.width);
    if (opts.height) params.set('height', opts.height);
    return `${this.url}/photo/:/transcode?${params}`;
  }

  private async *paginatedMetadata(
    libraryKey: string,
    typeFilter?: number,
  ): AsyncGenerator<PlexRawMetadata[]> {
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
    const total = first.MediaContainer.totalSize;
    if (total === undefined) {
      throw new Error(`Plex did not return totalSize for library ${libraryKey}`);
    }

    yield first.MediaContainer.Metadata ?? [];

    const remainingStarts: number[] = [];
    for (let s = ITEMS_PAGE_SIZE; s < total; s += ITEMS_PAGE_SIZE) {
      remainingStarts.push(s);
    }

    for (let i = 0; i < remainingStarts.length; i += FETCH_CONCURRENCY) {
      const batch = await Promise.all(
        remainingStarts.slice(i, i + FETCH_CONCURRENCY).map(fetchPage),
      );
      yield batch.flatMap((d) => d.MediaContainer.Metadata ?? []);
    }
  }

  async *libraryItems(libraryKey: string, typeFilter?: number): AsyncGenerator<PlexItem[]> {
    for await (const page of this.paginatedMetadata(libraryKey, typeFilter)) {
      yield mapItems(page);
    }
  }

  async *libraryEpisodes(libraryKey: string): AsyncGenerator<PlexEpisode[]> {
    for await (const page of this.paginatedMetadata(libraryKey, PLEX_TYPE.EPISODE)) {
      yield mapEpisodes(page);
    }
  }

  async *libraryTracks(libraryKey: string): AsyncGenerator<PlexTrack[]> {
    for await (const page of this.paginatedMetadata(libraryKey, PLEX_TYPE.TRACK)) {
      yield mapTracks(page);
    }
  }

  // Streams all play history for a library section across ALL users.
  // Episodes are returned at episode granularity; use grandparentRatingKey to attribute to show.
  async *libraryHistory(libraryKey: string): AsyncGenerator<PlexHistoryEntry[]> {
    const fetchPage = (start: number) =>
      this.get<{ MediaContainer: { Metadata?: PlexHistoryEntry[]; totalSize?: number } }>(
        `/status/sessions/history/all?librarySectionID=${libraryKey}&sort=viewedAt:desc`,
        {
          'X-Plex-Container-Start': String(start),
          'X-Plex-Container-Size': String(ITEMS_PAGE_SIZE),
        },
      );

    const first = await fetchPage(0);
    const total = first.MediaContainer.totalSize;
    if (total === undefined) {
      throw new Error(`Plex did not return totalSize for history of library ${libraryKey}`);
    }

    yield first.MediaContainer.Metadata ?? [];

    const remainingStarts: number[] = [];
    for (let s = ITEMS_PAGE_SIZE; s < total; s += ITEMS_PAGE_SIZE) {
      remainingStarts.push(s);
    }

    for (let i = 0; i < remainingStarts.length; i += FETCH_CONCURRENCY) {
      const batch = await Promise.all(
        remainingStarts.slice(i, i + FETCH_CONCURRENCY).map(fetchPage),
      );
      yield batch.flatMap((d) => d.MediaContainer.Metadata ?? []);
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
let _cachedServerId: number | null = null;

// Call after any credential/active-server change so the next request re-resolves from DB.
export function clearPlexClientCache(): void {
  _cachedClient = null;
  _cachedServerId = null;
}

// Clears settings.activeServerId (leaving the `servers` row and everything scoped to it
// untouched — reconnecting later restores it as-is) and drops the cached client so the
// next request re-resolves. Shared by every place that disconnects the active server —
// explicit DELETE /api/auth/plex and GET /api/auth/status's revoked-token handling — so
// a future third step in "disconnect" only needs to be added once.
export async function disconnectActiveServer(): Promise<void> {
  await db.update(settings).set({ activeServerId: null }).where(eq(settings.id, 1));
  clearPlexClientCache();
}

// Upserts a server row by its stable machineIdentifier so reconnecting to a
// previously-known server reuses its id — and everything scoped to that id
// (libraries/items/seasons/sync history) — instead of colliding with or losing
// another server's data. Refreshes name/url/token/lastConnectedAt on every call
// since those can legitimately change (server renamed, local IP changed, etc).
export async function findOrCreateServer(
  opts: { machineIdentifier: string; name: string; url: string; accessToken: string },
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const [row] = await db.insert(servers)
    .values({ ...opts, lastConnectedAt: now })
    .onConflictDoUpdate({
      target: servers.machineIdentifier,
      set: { name: opts.name, url: opts.url, accessToken: opts.accessToken, lastConnectedAt: now },
    })
    .returning({ id: servers.id });
  return row!.id;
}

type SettingsIdentity = { clientId: string; activeServerId: number | null };

async function resolveEnvServer(
  settingsRow: SettingsIdentity,
): Promise<{ client: PlexClient; serverId: number }> {
  const envUrl = Deno.env.get('PLEX_URL')!;
  const envToken = Deno.env.get('PLEX_TOKEN')!;
  const client = new PlexClient(envUrl, envToken, settingsRow.clientId);

  let machineIdentifier: string;
  try {
    // No OAuth resource list to pull a machine identifier from here — ask the PMS directly.
    machineIdentifier = await client.identity();
  } catch (err) {
    // Plex is briefly unreachable and we can't verify identity right now. If we've resolved
    // a server before, assume it's still the same one rather than failing outright — per
    // this app's own model, url/token can legitimately change without it being a different
    // server (dynamic IP, token rotation), so requiring an exact match here would be
    // stricter than the rest of the app treats "same server" (see machineIdentifier in
    // CLAUDE.md's Plex auth section). This self-corrects the moment Plex becomes reachable
    // again and identity() succeeds. Only the very first resolution ever (no activeServerId
    // yet) has nothing to fall back to and must fail.
    if (settingsRow.activeServerId !== null) {
      return { client, serverId: settingsRow.activeServerId };
    }
    throw err;
  }

  const serverId = await findOrCreateServer({
    machineIdentifier,
    name: 'Plex Server',
    url: envUrl,
    accessToken: envToken,
  });
  if (settingsRow.activeServerId !== serverId) {
    await db.update(settings).set({ activeServerId: serverId }).where(eq(settings.id, 1));
  }
  return { client, serverId };
}

async function resolveDbServer(
  settingsRow: SettingsIdentity,
): Promise<{ client: PlexClient; serverId: number }> {
  if (!settingsRow.activeServerId) {
    throw new PlexConfigError('Plex is not configured — complete setup at /setup');
  }

  const [serverRow] = await db.select({ url: servers.url, accessToken: servers.accessToken })
    .from(servers).where(eq(servers.id, settingsRow.activeServerId)).limit(1);
  if (!serverRow) {
    throw new PlexConfigError('Plex is not configured — complete setup at /setup');
  }

  const client = new PlexClient(serverRow.url, serverRow.accessToken, settingsRow.clientId);
  return { client, serverId: settingsRow.activeServerId };
}

// Single source of truth for "which server, and what client, are we talking to right
// now" — returns both atomically so callers never pair a client from one resolution
// with a serverId from another. Callers that need both (sync execution) should call
// this once and thread the result through, rather than calling createPlexClient() and
// getActiveServerId() separately, which could observe different servers if the cache
// is cleared in between.
export async function resolveActiveServer(): Promise<{ client: PlexClient; serverId: number }> {
  if (_cachedClient && _cachedServerId !== null) {
    return { client: _cachedClient, serverId: _cachedServerId };
  }

  // Ensure the settings row exists so clientId is always sent with requests.
  await db.insert(settings).values({ id: 1, clientId: crypto.randomUUID() })
    .onConflictDoNothing();
  const [settingsRow] = await db.select({
    clientId: settings.clientId,
    activeServerId: settings.activeServerId,
  }).from(settings).where(eq(settings.id, 1)).limit(1);

  // Env vars take precedence — power users and Docker setups can skip OAuth.
  const envUrl = Deno.env.get('PLEX_URL');
  const envToken = Deno.env.get('PLEX_TOKEN');
  let resolved: { client: PlexClient; serverId: number };
  if (envUrl && envToken) {
    resolved = await resolveEnvServer(settingsRow!);
  } else if (envUrl || envToken) {
    throw new PlexConfigError('Both PLEX_URL and PLEX_TOKEN must be set when using env var auth');
  } else {
    resolved = await resolveDbServer(settingsRow!);
  }

  _cachedClient = resolved.client;
  _cachedServerId = resolved.serverId;
  return resolved;
}

export async function createPlexClient(): Promise<PlexClient> {
  return (await resolveActiveServer()).client;
}

// The server currently synced/displayed. Throws PlexConfigError if unconfigured,
// mirroring createPlexClient().
export async function getActiveServerId(): Promise<number> {
  return (await resolveActiveServer()).serverId;
}

// Same as getActiveServerId(), but returns null instead of throwing — whether that's
// because Plex isn't configured, or because resolution failed for any other reason
// (e.g. Plex briefly unreachable while resolving an env-var server) — and never lets a
// resolution error surface as a 500 on these read-only routes. Routes through the same
// resolveActiveServer() cache as createPlexClient(), so an env-var install's server
// gets resolved on the first request that needs it rather than only reading whatever
// startupSyncIfStale() has (or hasn't yet, since it runs unawaited) written to
// settings.activeServerId in the background.
export async function getActiveServerIdOrNull(): Promise<number | null> {
  try {
    return await getActiveServerId();
  } catch {
    return null;
  }
}

export interface ActiveServerInfo {
  serverId: number;
  clientId: string;
  url: string;
  accessToken: string;
  machineIdentifier: string;
}

// Full connection/identity info for the active server, read fresh from the DB with
// no caching and without building a PlexClient. Shared by routes that need to
// validate or identify the active server (GET /auth/status, POST /webhook/plex)
// rather than actually talk to Plex.
export async function getActiveServer(): Promise<ActiveServerInfo | null> {
  const [row] = await db.select({
    serverId: settings.activeServerId,
    clientId: settings.clientId,
    url: servers.url,
    accessToken: servers.accessToken,
    machineIdentifier: servers.machineIdentifier,
  }).from(settings)
    .leftJoin(servers, eq(settings.activeServerId, servers.id))
    .where(eq(settings.id, 1)).limit(1);
  if (!row?.serverId || !row.url || !row.accessToken || !row.machineIdentifier) return null;
  return {
    serverId: row.serverId,
    clientId: row.clientId,
    url: row.url,
    accessToken: row.accessToken,
    machineIdentifier: row.machineIdentifier,
  };
}
