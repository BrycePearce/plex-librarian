import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { servers, settings } from '../../db/schema.ts';
import type {
  PlexActiveSession,
  PlexEpisode,
  PlexEpisodeMediaVersion,
  PlexHistoryEntry,
  PlexItem,
  PlexLibrary,
  PlexLocalAccount,
  PlexMediaPathPreview,
  PlexMediaVersion,
  PlexMediaVersionPathPreview,
  PlexMetadataIdentity,
  PlexRawMetadata,
  PlexTrack,
} from './types.ts';
import { buildPlexHeaders } from './headers.ts';
export { buildPlexHeaders, PLEX_CLIENT_PRODUCT, PLEX_TV } from './headers.ts';

const ITEMS_PAGE_SIZE = 300;
export const MAX_PREVIEW_MEDIA_PATHS = 2_000;
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

type PlexRawSession = {
  sessionKey?: string | number;
  ratingKey?: string | number;
  type?: string;
  grandparentRatingKey?: string | number;
  User?: { id?: number | string; title?: string };
  Player?: {
    address?: string;
    publicAddress?: string;
    machineIdentifier?: string;
    uuid?: string;
    title?: string;
    local?: boolean | number | string;
    state?: string;
  };
  Session?: { id?: string; location?: string };
};

function plexBoolean(value: boolean | number | string | undefined): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function mapActiveSessions(raw: PlexRawSession[]): PlexActiveSession[] {
  return raw.flatMap((session) => {
    const playerUuid = session.Player?.machineIdentifier ?? session.Player?.uuid ?? null;
    const ratingKey = session.ratingKey == null ? '' : String(session.ratingKey);
    const sessionKey = session.sessionKey == null
      ? session.Session?.id ??
        `${playerUuid ?? `user-${session.User?.id ?? 'unknown'}`}:${ratingKey}`
      : String(session.sessionKey);
    if (!ratingKey) return [];

    const rawState = session.Player?.state;
    const state: PlexActiveSession['state'] = rawState === 'paused'
      ? 'paused'
      : rawState === 'buffering'
      ? 'buffering'
      : 'playing';
    const explicitLocal = plexBoolean(session.Player?.local);
    const isLocal = explicitLocal ??
      (session.Session?.location === 'lan'
        ? true
        : session.Session?.location === 'wan'
        ? false
        : null);
    const parsedAccountId = Number(session.User?.id);

    return [{
      sessionKey,
      ratingKey,
      type: session.type ?? '',
      grandparentRatingKey: session.grandparentRatingKey == null
        ? null
        : String(session.grandparentRatingKey),
      state,
      accountId: Number.isSafeInteger(parsedAccountId) ? parsedAccountId : null,
      username: session.User?.title ?? null,
      playerUuid,
      playerTitle: session.Player?.title ?? null,
      ip: session.Player?.publicAddress ?? session.Player?.address ?? null,
      isLocal,
    }];
  });
}

// Plex reports sizes as 32-bit signed integers. Values 2–4 GB wrap negative and are
// corrected here. Values ≥ 4 GB wrap back to a smaller positive number and cannot be
// recovered — fileSize will be under-reported for those items.
// Result is stored in kilobytes to keep values well within 32-bit range for @db/sqlite.
const normalizeSize = (s: number) => s < 0 ? s + 2 ** 32 : s;

// Sums a single Media entry's own Part sizes — the per-version counterpart to
// extractFileSize's sum across every Media entry on the item.
function sumPartSizes(parts: Array<{ size?: number }> | undefined): number | null {
  const sized = (parts ?? []).filter((p) => p.size != null);
  if (sized.length === 0) return null;
  const bytes = sized.reduce((acc, p) => acc + normalizeSize(p.size!), 0);
  return Math.round(bytes / 1000);
}

function extractFileSize(item: PlexRawMetadata): number | null {
  const parts = item.Media?.flatMap((m) => m.Part ?? []).filter((p) => p.size != null) ?? [];
  if (parts.length === 0) return null;
  const bytes = parts.reduce((acc, p) => acc + normalizeSize(p.size!), 0);
  return Math.round(bytes / 1000);
}

function appendMediaPaths(
  metadata: PlexRawMetadata[],
  paths: string[],
  seen: Set<string>,
  limit: number,
): boolean {
  for (const item of metadata) {
    for (const media of item.Media ?? []) {
      for (const part of media.Part ?? []) {
        // Keep Plex's path byte-for-byte. Normalizing separators or case would corrupt
        // valid Windows/UNC paths and can also merge distinct Linux paths.
        if (typeof part.file !== 'string' || part.file.length === 0 || seen.has(part.file)) {
          continue;
        }
        if (paths.length >= limit) return true;
        seen.add(part.file);
        paths.push(part.file);
      }
    }
  }
  return false;
}

export function extractExternalIds(
  item: Pick<PlexRawMetadata, 'Guid' | 'guid'>,
): { tmdbId: number | null; tvdbId: number | null } {
  const ids = [...(item.Guid ?? []).map((guid) => guid.id), item.guid].filter(
    (value): value is string => typeof value === 'string',
  );

  const findId = (provider: 'tmdb' | 'tvdb'): number | null => {
    for (const raw of ids) {
      const modern = raw.match(new RegExp(`^${provider}://(\\d+)`, 'i'));
      const legacy = raw.match(
        provider === 'tmdb' ? /themoviedb:\/\/(\d+)/i : /thetvdb:\/\/(\d+)/i,
      );
      const match = modern ?? legacy;
      if (match) return Number(match[1]);
    }
    return null;
  };

  return { tmdbId: findId('tmdb'), tvdbId: findId('tvdb') };
}

function mapItems(raw: PlexRawMetadata[]): PlexItem[] {
  return raw.map((item) => {
    const externalIds = extractExternalIds(item);
    return {
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
      ...externalIds,
    };
  });
}

function mapMediaVersions(raw: PlexRawMetadata[]): PlexMediaVersion[] {
  return raw
    .filter((item) => item.type === 'movie')
    .flatMap((item) =>
      (item.Media ?? [])
        .filter((m): m is typeof m & { id: number } => m.id != null)
        .map((m) => ({
          mediaId: m.id,
          itemRatingKey: item.ratingKey,
          videoResolution: m.videoResolution ?? null,
          bitrate: m.bitrate ?? null,
          videoCodec: m.videoCodec ?? null,
          container: m.container ?? null,
          fileSize: sumPartSizes(m.Part),
        }))
    );
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

// Write-time duplicate filter: only episodes whose valid (id != null) Media count is
// already >= 2 ever produce rows here — see episodeMediaVersions in db/schema.ts for
// why. Filtering on the *valid* count (not raw Media.length) matters: an episode with
// one addressable version and one malformed entry (no id) must not end up with a
// single-row "duplicate" that the delete route's last-version guard can never resolve.
// Same parent/grandparent/parentIndex requirement as mapEpisodes, deliberately — an
// episode that syncs normally there must not silently fail to surface here too.
// episodeIndex falls back to 0 (display-only miscount, same style as viewCount ?? 0
// below) rather than excluding the episode outright: `index` missing while
// `parentIndex` is present is an edge case with no confirmed real-world trigger, but
// requiring it would mean a genuine duplicate-episode's versions never appear on the
// Duplicates page or stale-table badge with no error indicating why.
function mapEpisodeMediaVersions(raw: PlexRawMetadata[]): PlexEpisodeMediaVersion[] {
  return raw
    .filter((item) => item.parentRatingKey && item.grandparentRatingKey && item.parentIndex != null)
    .flatMap((item) => {
      const validMedia = (item.Media ?? [])
        .filter((m): m is typeof m & { id: number } => m.id != null);
      if (validMedia.length < 2) return [];
      return validMedia.map((m) => ({
        mediaId: m.id,
        episodeRatingKey: item.ratingKey,
        seasonRatingKey: item.parentRatingKey!,
        showRatingKey: item.grandparentRatingKey!,
        episodeTitle: item.title,
        episodeIndex: item.index ?? 0,
        seasonIndex: item.parentIndex!,
        videoResolution: m.videoResolution ?? null,
        bitrate: m.bitrate ?? null,
        videoCodec: m.videoCodec ?? null,
        container: m.container ?? null,
        fileSize: sumPartSizes(m.Part),
      }));
    });
}

export class PlexClient {
  private readonly url: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly clientId?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.url = url.replace(/\/$/, '');
  }

  get serverUrl(): string {
    return this.url;
  }

  private async get<T>(
    path: string,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.url}${path}`;
    const headers = { ...extraHeaders, ...buildPlexHeaders(this.clientId, this.token) };

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0) {
        // Exponential backoff with 50% jitter: ~1s, ~2s
        const base = 1000 * 2 ** (attempt - 1);
        await abortableDelay(base + Math.random() * base * 0.5, signal);
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        });
      } catch (err) {
        // A caller-provided deadline is authoritative. Retrying after it expires would
        // leave informational preview requests running after the modal has moved on.
        signal?.throwIfAborted();
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

  // Accounts the PMS itself knows about — see PlexLocalAccount above for why this
  // exists (bridging local ids used by webhooks/history to the global ids used by the
  // plex.tv roster). id 0's nameless placeholder is filtered out here so callers never
  // have to remember to skip it.
  async localAccounts(): Promise<PlexLocalAccount[]> {
    const data = await this.get<
      { MediaContainer: { Account?: Array<{ id: number; name?: string }> } }
    >(
      '/accounts',
    );
    return (data.MediaContainer.Account ?? [])
      .filter((a): a is { id: number; name: string } => a.id !== 0 && !!a.name);
  }

  async activeSessions(): Promise<PlexActiveSession[]> {
    const data = await this.get<{ MediaContainer: { Metadata?: PlexRawSession[] } }>(
      '/status/sessions',
    );
    return mapActiveSessions(data.MediaContainer.Metadata ?? []);
  }

  async metadataIdentity(ratingKey: string): Promise<PlexMetadataIdentity | null> {
    const url = `${this.url}/library/metadata/${encodeURIComponent(ratingKey)}?includeGuids=1`;
    const res = await this.fetchImpl(url, {
      headers: buildPlexHeaders(this.clientId, this.token),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) {
      res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      res.body?.cancel();
      throw new Error(`Plex ${res.status} reading metadata ${ratingKey}`);
    }
    const data = await res.json() as { MediaContainer: { Metadata?: PlexRawMetadata[] } };
    const item = data.MediaContainer.Metadata?.[0];
    if (!item) return null;
    const externalIds = extractExternalIds(item);
    return {
      ratingKey: item.ratingKey,
      title: item.title,
      type: item.type,
      librarySectionId: item.librarySectionID == null ? null : String(item.librarySectionID),
      tmdbId: externalIds.tmdbId,
      tvdbId: externalIds.tvdbId,
      parentRatingKey: item.parentRatingKey ?? null,
      grandparentRatingKey: item.grandparentRatingKey ?? null,
      seasonIndex: item.parentIndex ?? null,
      index: item.index ?? null,
      media: (item.Media ?? []).flatMap((media) =>
        media.id == null ? [] : [{
          mediaId: media.id,
          videoResolution: media.videoResolution ?? null,
          bitrate: media.bitrate ?? null,
          videoCodec: media.videoCodec ?? null,
          container: media.container ?? null,
          fileSize: extractFileSize({ ...item, Media: [media] }),
        }]
      ),
    };
  }

  // Fetches current Plex-reported Part paths solely for confirmation UI. Movies and
  // other leaf items expose Media directly; shows and artists require allLeaves because
  // this app intentionally does not persist every episode/track. The cap prevents a
  // bulk preview from accumulating an unbounded TV/music library in memory.
  async mediaPathPreview(
    ratingKey: string,
    itemType: string,
    limit = MAX_PREVIEW_MEDIA_PATHS,
    signal?: AbortSignal,
  ): Promise<PlexMediaPathPreview> {
    const paths: string[] = [];
    const seen = new Set<string>();
    const encodedKey = encodeURIComponent(ratingKey);
    if (itemType !== 'show' && itemType !== 'artist') {
      const data = await this.get<{ MediaContainer: { Metadata?: PlexRawMetadata[] } }>(
        `/library/metadata/${encodedKey}`,
        undefined,
        signal,
      );
      const truncated = appendMediaPaths(
        data.MediaContainer.Metadata ?? [],
        paths,
        seen,
        limit,
      );
      return { paths, truncated };
    }

    const basePath = `/library/metadata/${encodedKey}/allLeaves`;
    let start = 0;
    // Bound leaf inspection as well as returned paths. A malformed or restricted Plex
    // response might contain millions of leaves but omit Part.file on every one.
    const leafLimit = Math.max(ITEMS_PAGE_SIZE, limit);
    while (true) {
      const data = await this.get<{
        MediaContainer: { Metadata?: PlexRawMetadata[]; totalSize?: number };
      }>(basePath, {
        'X-Plex-Container-Start': String(start),
        'X-Plex-Container-Size': String(ITEMS_PAGE_SIZE),
      }, signal);
      const metadata = data.MediaContainer.Metadata ?? [];
      if (appendMediaPaths(metadata, paths, seen, limit)) {
        return { paths, truncated: true };
      }
      start += metadata.length;
      const total = data.MediaContainer.totalSize;
      if (
        metadata.length === 0 ||
        (total !== undefined ? start >= total : metadata.length < ITEMS_PAGE_SIZE)
      ) {
        return { paths, truncated: false };
      }
      if (start >= leafLimit) return { paths, truncated: true };
      if (paths.length >= limit) return { paths, truncated: true };
    }
  }

  // Resolves Part paths for each live Media entry under one movie or episode. Unlike
  // mediaPathPreview(), this preserves the Media id boundary so a duplicate-version
  // confirmation never attributes another version's file to the selected one.
  async mediaVersionPathPreviews(
    ratingKey: string,
    limitPerVersion = 100,
    signal?: AbortSignal,
  ): Promise<PlexMediaVersionPathPreview[]> {
    const data = await this.get<{ MediaContainer: { Metadata?: PlexRawMetadata[] } }>(
      `/library/metadata/${encodeURIComponent(ratingKey)}`,
      undefined,
      signal,
    );
    return (data.MediaContainer.Metadata ?? []).flatMap((metadata) =>
      (metadata.Media ?? []).flatMap((media) => {
        if (media.id == null) return [];
        const paths: string[] = [];
        const seen = new Set<string>();
        let truncated = false;
        for (const part of media.Part ?? []) {
          if (typeof part.file !== 'string' || part.file.length === 0 || seen.has(part.file)) {
            continue;
          }
          if (paths.length >= limitPerVersion) {
            truncated = true;
            break;
          }
          seen.add(part.file);
          paths.push(part.file);
        }
        return [{ mediaId: media.id, paths, truncated }];
      })
    );
  }

  // Deletes an item's media from Plex (metadata + underlying file(s) on disk).
  // Requires "Allow media deletion" enabled on the server, or Plex rejects with a 5xx —
  // surfaced as-is so the UI can show Plex's own reason rather than a generic failure.
  // Not retried: unlike get(), a failed delete is far more likely to be a real
  // rejection (deletion disabled, permissions) than a transient blip worth retrying.
  async deleteItem(ratingKey: string): Promise<void> {
    const url = `${this.url}/library/metadata/${ratingKey}`;
    const headers = buildPlexHeaders(this.clientId, this.token);
    const res = await this.fetchImpl(url, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      // Some failures (e.g. 404 for an item Plex doesn't recognize) come back as a
      // generic web-server HTML error page rather than a useful API error body — only
      // surface response text when it's not HTML, so callers never have to render markup.
      const contentType = res.headers.get('content-type') ?? '';
      const rawText = await res.text().catch(() => '');
      const text = contentType.includes('html') ? '' : rawText.slice(0, 500);
      throw new PlexDeleteError(
        res.status,
        `Plex ${res.status} deleting ${ratingKey}${text ? `: ${text}` : ''}`,
      );
    }
  }

  // Deletes a single Media version (one file) from an item without touching its other
  // versions or the item itself — distinct from deleteItem, which removes the whole
  // item and everything under it. Same auth/error/retry behavior as deleteItem; see
  // its comment above for the reasoning.
  async deleteMedia(ratingKey: string, mediaId: number): Promise<void> {
    const url = `${this.url}/library/metadata/${ratingKey}/media/${mediaId}`;
    const headers = buildPlexHeaders(this.clientId, this.token);
    const res = await this.fetchImpl(url, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const contentType = res.headers.get('content-type') ?? '';
      const rawText = await res.text().catch(() => '');
      const text = contentType.includes('html') ? '' : rawText.slice(0, 500);
      throw new PlexDeleteError(
        res.status,
        `Plex ${res.status} deleting media ${mediaId} of ${ratingKey}${text ? `: ${text}` : ''}`,
      );
    }
  }

  async refreshLibrary(libraryKey: string): Promise<void> {
    const url = `${this.url}/library/sections/${encodeURIComponent(libraryKey)}/refresh`;
    const res = await this.fetchImpl(url, {
      headers: buildPlexHeaders(this.clientId, this.token),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Plex ${res.status} refreshing library ${libraryKey}`);
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
    includeGuids = false,
  ): AsyncGenerator<PlexRawMetadata[]> {
    const params = new URLSearchParams();
    if (typeFilter !== undefined) params.set('type', String(typeFilter));
    if (includeGuids) params.set('includeGuids', '1');
    const query = params.toString();
    const basePath = `/library/sections/${libraryKey}/all${query ? `?${query}` : ''}`;
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

  // mediaVersions is only ever non-empty for movie libraries — mapMediaVersions filters
  // to type === 'movie' internally, and TV/artist libraries' raw pages never contain
  // movie-typed entries in the first place (their typeFilter excludes them), so no
  // separate lib.type check is needed at the call site.
  async *libraryItems(
    libraryKey: string,
    typeFilter?: number,
  ): AsyncGenerator<{ items: PlexItem[]; mediaVersions: PlexMediaVersion[] }> {
    // External provider GUIDs are opt-in on Plex's bulk library endpoint. Request them
    // only for item/show syncs: episode and track streams can contain millions of rows
    // and do not need TMDB/TVDB IDs.
    for await (const page of this.paginatedMetadata(libraryKey, typeFilter, true)) {
      yield { items: mapItems(page), mediaVersions: mapMediaVersions(page) };
    }
  }

  async *libraryEpisodes(
    libraryKey: string,
  ): AsyncGenerator<{ episodes: PlexEpisode[]; episodeMediaVersions: PlexEpisodeMediaVersion[] }> {
    for await (const page of this.paginatedMetadata(libraryKey, PLEX_TYPE.EPISODE)) {
      yield { episodes: mapEpisodes(page), episodeMediaVersions: mapEpisodeMediaVersions(page) };
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

// Thrown by deleteItem() on a non-ok response. Carries the HTTP status so callers can
// distinguish "Plex already doesn't have this item" (404 — likely deleted outside this
// app) from a real rejection (permissions, deletion disabled, etc.).
export class PlexDeleteError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'PlexDeleteError';
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
