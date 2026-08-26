import type { ArrType } from '@plex-librarian/shared/types.ts';

export interface ArrMediaRecord {
  id: number;
  title: string;
  titleSlug?: string | null;
  path: string | null;
  seasons: ArrSeasonSummary[] | null;
  tmdbId?: number | null;
  year?: number | null;
  monitored?: boolean | null;
}

export interface RadarrImportExclusion {
  id: number;
  tmdbId: number;
  movieTitle: string;
  movieYear: number;
}

export interface ArrSeasonSummary {
  seasonNumber: number;
  episodeFileCount: number | null;
  size: number | null;
}

export interface ArrTorrentAssociation {
  hash: string;
  sourcePath: string | null;
  payloadPath: string | null;
  importedPath: string | null;
  historyId: number | null;
  date: string | null;
}

export interface ArrExtraFile {
  relativePath: string;
  type: 'subtitle' | 'metadata' | 'other';
  movieFileId: number | null;
}

export interface RadarrMovieRecord {
  id: number;
  path: string;
}

export const RADARR_PATH_ADOPTION_MIN_VERSION = '6.3.0.10514';
export const RADARR_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
export const RADARR_CATALOG_MAX_RECORDS = 50_000;
export const RADARR_FILESYSTEM_MAX_BYTES = 2 * 1024 * 1024;
export const RADARR_FILESYSTEM_MAX_ENTRIES = 2_000;
export const SONARR_SEASON_COORDINATION_MIN_VERSION = '4.0.19.2979';
export const SONARR_SERIES_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const SONARR_SERIES_SNAPSHOT_MAX_RECORDS = 50_000;
export const SONARR_ACTIVITY_MAX_RECORDS = 1_000;
export const SONARR_MANUAL_IMPORT_MAX_RECORDS = 500;
export const SONARR_MONITORING_CHUNK_SIZE = 50;
const ARR_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
const ARR_HISTORY_MAX_RECORDS = 50_000;

export interface RadarrFilesystemEntry {
  path: string;
  name: string;
  type: 'file' | 'folder';
}

export interface RadarrRootFolder {
  id: number;
  path: string;
}

export interface RadarrCatalogMoviePath {
  id: number;
  tmdbId: number;
  path: string;
}

export interface RadarrActivityEvidence {
  quiet: boolean;
  blocking: Array<{ source: 'queue' | 'command'; id: number; name: string }>;
}

export interface RadarrPathAdoptionCapabilities {
  available: boolean;
  version: string | null;
  minimumVersion: typeof RADARR_PATH_ADOPTION_MIN_VERSION;
  behaviorFingerprint: string | null;
  behavior: {
    autoUnmonitorPreviouslyDownloadedMovies: boolean;
    deleteEmptyFolders: boolean;
    fileDate: string;
    rescanAfterRefresh: string;
    metadataConsumerCount: number;
    notificationConsumerCount: number;
  } | null;
  reason?: string;
}

export interface RadarrMoviePathUpdateResult {
  before: Record<string, unknown> & {
    id: number;
    tmdbId: number;
    path: string;
    monitored: boolean;
  };
  after: Record<string, unknown> & {
    id: number;
    tmdbId: number;
    path: string;
    monitored: boolean;
  };
  changed: boolean;
}

export interface ArrManagedFile {
  relativePath: string;
  size: number | null;
  /** Stable provider record identity when the provider exposes one. */
  id?: number;
  /** Exact provider-managed absolute path. Prefer this over rebuilding from a title root. */
  path?: string | null;
}

export interface ArrManagedVersionFile extends ArrManagedFile {
  id: number;
  path: string | null;
}

export interface ArrMonitorTarget {
  id: number;
  monitored: boolean;
}

export interface SonarrEpisodeMonitorIdentity {
  episodeId: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
}

export interface RadarrMovieMonitorIdentity {
  movieId: number;
  tmdbId: number;
  path: string;
}

export interface ArrEpisodeManagedFile {
  episodeId: number;
  file: ArrManagedVersionFile | null;
  shared?: boolean;
}

export interface SonarrSeriesEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeFileId: number;
  monitored: boolean;
}

export interface SonarrSeriesEpisodeFile {
  id: number;
  seriesId: number;
  path: string;
  relativePath: string;
  size: number;
  episodeIds: number[];
}

export interface SonarrSeriesSnapshot {
  episodes: SonarrSeriesEpisode[];
  files: SonarrSeriesEpisodeFile[];
}

const SONARR_EPISODE_FILE_OWNER_MAX_RECORDS = 500;

export interface SonarrManualImportCandidate {
  path: string;
  size: number;
  seriesId: number;
  seasonNumber: number;
  episodeIds: number[];
  quality: {
    quality: { id: number; name: string; source: string; resolution: number };
    revision: { version: number; real: number; isRepack: boolean };
  };
  languages: Array<{ id: number; name: string }>;
  releaseGroup: string;
  indexerFlags: number;
  releaseType: string;
  rejectionReasons: string[];
}

export interface SonarrCommandEvidence {
  id: number;
  name: string;
  status: string;
}

export interface SonarrUntrackedImportCandidate {
  path: string;
  size: number;
  episodeIds: number[];
  rejectionReasons: string[];
}

export interface SonarrSeasonCoordinationCapabilities {
  available: boolean;
  version: string | null;
  minimumVersion: typeof SONARR_SEASON_COORDINATION_MIN_VERSION;
  reason?: string;
}

export class ArrApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function normalizeArrUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  parsed.hash = '';
  parsed.search = '';
  const path = parsed.pathname.replace(/\/$/, '').replace(/\/api\/v3$/i, '');
  parsed.pathname = path;
  return parsed.toString().replace(/\/$/, '');
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const left = parse(actual);
  const right = parse(minimum)!;
  if (!left || left.some((part) => !Number.isSafeInteger(part) || part < 0)) return false;
  for (let index = 0; index < right.length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function supportedSonarrSeasonMutationVersion(actual: string): boolean {
  const major = /^(\d+)\./.exec(actual.trim());
  return major?.[1] === '4' && versionAtLeast(actual, SONARR_SEASON_COORDINATION_MIN_VERSION);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
        .join(',')
    }}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function radarrPathComparison(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US');
}

function absolutePathComparison(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed !== path) return null;
  const unix = trimmed.startsWith('/');
  const windows = /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(trimmed);
  if (!unix && !windows) return null;
  return trimmed.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US');
}

const RADARR_COMPUTED_MOVIE_FIELDS = new Set([
  'movieFileId',
  'hasFile',
  'sizeOnDisk',
  'statistics',
  'lastInfoSync',
  'rootFolderPath',
  'tags',
]);

function assertOnlyRadarrMovieChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  intendedFields: readonly string[],
): void {
  const allowed = new Set([...RADARR_COMPUTED_MOVIE_FIELDS, ...intendedFields]);
  const stableBefore = Object.fromEntries(
    Object.entries(before).filter(([key]) => !allowed.has(key)),
  );
  const stableAfter = Object.fromEntries(
    Object.entries(after).filter(([key]) => !allowed.has(key)),
  );
  if (stableJson(stableBefore) !== stableJson(stableAfter)) {
    throw new ArrApiError('Radarr changed unrelated movie fields during the update');
  }
}

export class ArrClient {
  private readonly baseUrl: string;

  constructor(
    readonly type: ArrType,
    url: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = `${normalizeArrUrl(url)}/api/v3`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'X-Api-Key': this.apiKey,
          ...init?.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ArrApiError(
        `${this.type === 'radarr' ? 'Radarr' : 'Sonarr'} is unreachable: ${
          error instanceof Error ? error.message : 'request failed'
        }`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ArrApiError(
        `${this.type === 'radarr' ? 'Radarr' : 'Sonarr'} returned ${response.status}${
          detail ? `: ${detail.slice(0, 300)}` : ''
        }`,
        response.status,
      );
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private async boundedRequest<T>(
    path: string,
    maxBytes: number,
    description: string,
    init?: RequestInit,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'X-Api-Key': this.apiKey,
          ...init?.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ArrApiError(
          `${this.type === 'radarr' ? 'Radarr' : 'Sonarr'} returned ${response.status}${
            detail ? `: ${detail.slice(0, 300)}` : ''
          }`,
          response.status,
        );
      }
      if (!response.body) {
        throw new ArrApiError(
          `${this.type === 'radarr' ? 'Radarr' : 'Sonarr'} returned an empty ${description}`,
        );
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          throw new ArrApiError(
            `${
              this.type === 'radarr' ? 'Radarr' : 'Sonarr'
            } ${description} exceeded the ${maxBytes}-byte safety limit`,
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
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      } catch {
        throw new ArrApiError(
          `${this.type === 'radarr' ? 'Radarr' : 'Sonarr'} returned malformed ${description}`,
        );
      }
    } catch (error) {
      if (error instanceof ArrApiError) throw error;
      throw new ArrApiError(
        `${
          this.type === 'radarr' ? 'Radarr' : 'Sonarr'
        } is unreachable while reading ${description}: ${
          error instanceof Error ? error.message : 'request failed'
        }`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async testConnection(): Promise<{ version: string | null }> {
    const status = await this.request<{ version?: string; appName?: string }>('/system/status');
    const expected = this.type === 'radarr' ? 'radarr' : 'sonarr';
    if (status.appName && status.appName.toLowerCase() !== expected) {
      throw new ArrApiError(
        `Expected ${
          this.type === 'radarr' ? 'Radarr' : 'Sonarr'
        } but connected to ${status.appName}`,
      );
    }
    return { version: status.version ?? null };
  }

  async lookup(externalId: number): Promise<ArrMediaRecord | null> {
    const path = this.type === 'radarr'
      ? `/movie?tmdbId=${externalId}`
      : `/series?tvdbId=${externalId}`;
    const records = await this.request<
      Array<{
        id: number;
        title?: string;
        titleSlug?: string;
        path?: string;
        tmdbId?: number;
        year?: number;
        monitored?: boolean;
        seasons?: Array<{
          seasonNumber?: number;
          statistics?: { episodeFileCount?: number; sizeOnDisk?: number };
        }>;
      }>
    >(path);
    if (!Array.isArray(records)) {
      throw new ArrApiError(
        `${this.type === 'radarr' ? 'Radarr' : 'Sonarr'} returned an invalid lookup response`,
      );
    }
    if (records.length > 1) {
      throw new ArrApiError(
        `${
          this.type === 'radarr' ? 'Radarr' : 'Sonarr'
        } returned multiple records for external ID ${externalId}`,
      );
    }
    const record = records[0];
    if (record === undefined) return null;
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      !Number.isInteger(record.id) ||
      record.id <= 0
    ) {
      throw new ArrApiError(
        `${this.type === 'radarr' ? 'Radarr' : 'Sonarr'} returned an invalid managed record`,
      );
    }
    return {
      id: record.id,
      title: record.title ?? String(record.id),
      ...(record.titleSlug?.trim() ? { titleSlug: record.titleSlug.trim() } : {}),
      path: record.path?.trim() || null,
      tmdbId: Number.isSafeInteger(record.tmdbId) ? record.tmdbId! : null,
      year: Number.isSafeInteger(record.year) ? record.year! : null,
      monitored: typeof record.monitored === 'boolean' ? record.monitored : null,
      seasons: this.type === 'sonarr'
        ? (record.seasons ?? [])
          .flatMap((season) => {
            const seasonNumber = Number(season.seasonNumber);
            if (!Number.isInteger(seasonNumber) || seasonNumber < 0) return [];
            const rawFileCount = Number(season.statistics?.episodeFileCount);
            const episodeFileCount = Number.isInteger(rawFileCount) && rawFileCount >= 0
              ? rawFileCount
              : null;
            const rawSize = Number(season.statistics?.sizeOnDisk);
            const size = Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : null;
            // Sonarr also returns future/empty season metadata. Only show seasons with
            // managed files so the deletion tree describes disk contents being removed.
            if (episodeFileCount === 0 && (size === null || size === 0)) return [];
            return [
              {
                seasonNumber,
                episodeFileCount,
                size,
              } satisfies ArrSeasonSummary,
            ];
          })
          .sort((a, b) => a.seasonNumber - b.seasonNumber)
        : null,
    };
  }

  async radarrMovieExistsById(movieId: number): Promise<boolean> {
    if (this.type !== 'radarr') throw new ArrApiError('Movie reads require Radarr');
    if (!Number.isSafeInteger(movieId) || movieId <= 0) {
      throw new ArrApiError('Radarr movie ID is invalid');
    }
    let record: unknown;
    try {
      record = await this.request<unknown>(`/movie/${movieId}`);
    } catch (error) {
      if (error instanceof ArrApiError && error.status === 404) return false;
      throw error;
    }
    if (
      !record || typeof record !== 'object' || Array.isArray(record) ||
      (record as { id?: unknown }).id !== movieId
    ) {
      throw new ArrApiError('Radarr returned a conflicting or malformed targeted movie');
    }
    return true;
  }

  async extraFiles(mediaId: number): Promise<ArrExtraFile[]> {
    if (this.type !== 'radarr') return [];
    const records = await this.request<
      Array<{
        relativePath?: string;
        type?: number | string;
        movieFileId?: number | null;
      }>
    >(`/extrafile?movieId=${mediaId}`);
    if (!Array.isArray(records)) {
      throw new ArrApiError('Radarr returned an invalid extra-file response');
    }
    return records.flatMap((record) => {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        throw new ArrApiError('Radarr returned an invalid extra-file record');
      }
      const relativePath = record.relativePath?.trim();
      if (!relativePath) {
        throw new ArrApiError('Radarr returned an invalid extra-file record');
      }
      const movieFileId = record.movieFileId;
      if (!Object.hasOwn(record, 'movieFileId') || movieFileId === undefined) {
        throw new ArrApiError('Radarr returned missing extra-file ownership');
      }
      if (movieFileId !== null && (!Number.isInteger(movieFileId) || movieFileId <= 0)) {
        throw new ArrApiError('Radarr returned invalid extra-file ownership');
      }
      const rawType = String(record.type ?? '').toLowerCase();
      const type = rawType === '0' || rawType === 'subtitle'
        ? 'subtitle'
        : rawType === '1' || rawType === 'metadata'
        ? 'metadata'
        : 'other';
      return [
        {
          relativePath,
          type,
          movieFileId,
        } satisfies ArrExtraFile,
      ];
    });
  }

  async radarrMovie(mediaId: number): Promise<RadarrMovieRecord> {
    if (this.type !== 'radarr') throw new ArrApiError('Movie reads require Radarr');
    const record = await this.request<{ id?: number; path?: string }>(`/movie/${mediaId}`);
    const path = record?.path?.trim();
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      !Number.isInteger(record.id) ||
      record.id !== mediaId ||
      !path
    ) {
      throw new ArrApiError('Radarr returned an invalid targeted movie record');
    }
    return { id: mediaId, path };
  }

  async fileVisibility(path: string): Promise<'file' | 'folder' | 'missing'> {
    const result = await this.request<{ type?: string }>(
      `/filesystem/type?path=${encodeURIComponent(path)}`,
    );
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !['file', 'folder', 'missing', 'none', 'unknown'].includes(result.type ?? '')
    ) {
      throw new ArrApiError(
        `${
          this.type === 'radarr' ? 'Radarr' : 'Sonarr'
        } returned an invalid file visibility response`,
      );
    }
    const type = result.type!;
    if (type === 'missing' || type === 'none' || type === 'unknown') return 'missing';
    return type === 'file' ? 'file' : 'folder';
  }

  async sonarrExactFileExists(path: string): Promise<boolean> {
    if (this.type !== 'sonarr') {
      throw new ArrApiError('Exact EpisodeFile checks require Sonarr');
    }
    const result = await this.request<{ type?: string }>(
      `/filesystem/type?path=${encodeURIComponent(path)}`,
    );
    if (
      !result || typeof result !== 'object' || Array.isArray(result) ||
      (result.type !== 'file' && result.type !== 'folder')
    ) {
      throw new ArrApiError('Sonarr returned an invalid exact-file response');
    }
    return result.type === 'file';
  }

  async mediaFiles(mediaId: number): Promise<ArrManagedFile[] | null> {
    if (this.type === 'sonarr') {
      const snapshot = await this.sonarrSeriesSnapshot(mediaId);
      return snapshot.files.map((file) => ({
        id: file.id,
        path: file.path,
        relativePath: file.relativePath,
        size: file.size,
      }));
    }
    const records = await this.request<
      Array<{ relativePath?: string; path?: string; size?: number }>
    >(`/moviefile?movieId=${mediaId}`);
    return records.flatMap((record) => {
      const absolutePath = record.path?.trim();
      const relativePath = record.relativePath?.trim() ||
        absolutePath
          ?.split(/[\\/]+/)
          .filter(Boolean)
          .at(-1);
      if (!relativePath) return [];
      const size = Number(record.size);
      return [
        {
          relativePath,
          size: Number.isFinite(size) && size >= 0 ? size : null,
        } satisfies ArrManagedFile,
      ];
    });
  }

  async radarrManagedFile(mediaId: number): Promise<ArrManagedVersionFile | null> {
    if (this.type !== 'radarr') return null;
    const records = await this.request<
      Array<{
        id?: number;
        relativePath?: string;
        path?: string;
        size?: number;
      }>
    >(`/moviefile?movieId=${mediaId}`);
    if (!Array.isArray(records)) {
      throw new ArrApiError('Radarr returned an invalid managed-file response');
    }
    if (records.length > 1) {
      throw new ArrApiError('Radarr returned multiple managed files for one movie');
    }
    const record = records[0];
    if (record === undefined) return null;
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new ArrApiError('Radarr returned an invalid managed movie file');
    }
    const absolutePath = record.path?.trim() || null;
    const relativePath = record.relativePath?.trim() ||
      absolutePath
        ?.split(/[\\/]+/)
        .filter(Boolean)
        .at(-1);
    if (!Number.isInteger(record.id) || record.id! <= 0 || !relativePath) {
      throw new ArrApiError('Radarr returned an invalid managed movie file');
    }
    const size = record.size;
    return {
      id: record.id!,
      relativePath,
      path: absolutePath,
      size: Number.isSafeInteger(size) && size! >= 0 ? size! : null,
    };
  }

  async episodeManagedFile(
    seriesId: number,
    seasonNumber: number,
    episodeNumber: number,
  ): Promise<ArrEpisodeManagedFile | null> {
    if (this.type !== 'sonarr') return null;
    const episodes = await this.request<
      Array<{
        id?: number;
        seasonNumber?: number;
        episodeNumber?: number;
        episodeFileId?: number;
      }>
    >(`/episode?seriesId=${seriesId}`);
    if (!Array.isArray(episodes)) {
      throw new ArrApiError('Sonarr returned an invalid episode response');
    }
    const matchingEpisodes = episodes.filter(
      (candidate) =>
        candidate.seasonNumber === seasonNumber && candidate.episodeNumber === episodeNumber,
    );
    if (matchingEpisodes.length > 1) {
      throw new ArrApiError('Sonarr returned multiple records for the requested episode');
    }
    const episode = matchingEpisodes[0];
    if (!episode) return null;
    if (!Number.isInteger(episode.id) || episode.id! <= 0) {
      throw new ArrApiError('Sonarr returned an invalid managed episode');
    }
    if (episode.episodeFileId === undefined || episode.episodeFileId === 0) {
      return { episodeId: episode.id!, file: null, shared: false };
    }
    if (!Number.isInteger(episode.episodeFileId) || episode.episodeFileId! < 0) {
      throw new ArrApiError('Sonarr returned an invalid episode file identity');
    }
    const shared = episodes.some(
      (candidate) =>
        candidate.id !== episode.id && candidate.episodeFileId === episode.episodeFileId,
    );
    const record = await this.request<{
      id?: number;
      relativePath?: string;
      path?: string;
      size?: number;
    }>(`/episodefile/${episode.episodeFileId}`);
    const absolutePath = record.path?.trim() || null;
    const relativePath = record.relativePath?.trim() ||
      absolutePath
        ?.split(/[\\/]+/)
        .filter(Boolean)
        .at(-1);
    if (!Number.isInteger(record.id) || record.id !== episode.episodeFileId || !relativePath) {
      throw new ArrApiError('Sonarr returned an invalid managed episode file');
    }
    const size = Number(record.size);
    return {
      episodeId: episode.id!,
      shared,
      file: {
        id: record.id!,
        relativePath,
        path: absolutePath,
        size: Number.isFinite(size) && size >= 0 ? size : null,
      },
    };
  }

  async sonarrSeasonCoordinationCapabilities(): Promise<SonarrSeasonCoordinationCapabilities> {
    if (this.type !== 'sonarr') {
      return {
        available: false,
        version: null,
        minimumVersion: SONARR_SEASON_COORDINATION_MIN_VERSION,
        reason: 'Season coordination requires Sonarr',
      };
    }
    const status = await this.request<{ version?: unknown; appName?: unknown }>('/system/status');
    const version = typeof status.version === 'string' ? status.version.trim() : null;
    if (typeof status.appName !== 'string' || status.appName.toLowerCase() !== 'sonarr') {
      return {
        available: false,
        version,
        minimumVersion: SONARR_SEASON_COORDINATION_MIN_VERSION,
        reason: 'The configured service did not identify itself as Sonarr',
      };
    }
    if (!version || !supportedSonarrSeasonMutationVersion(version)) {
      return {
        available: false,
        version,
        minimumVersion: SONARR_SEASON_COORDINATION_MIN_VERSION,
        reason: version
          ? `Sonarr ${SONARR_SEASON_COORDINATION_MIN_VERSION} or newer within major version 4 is required; this instance reports ${version}`
          : `Sonarr version could not be verified; ${SONARR_SEASON_COORDINATION_MIN_VERSION} or newer within major version 4 is required`,
      };
    }
    return { available: true, version, minimumVersion: SONARR_SEASON_COORDINATION_MIN_VERSION };
  }

  async sonarrSeriesSnapshot(seriesId: number): Promise<SonarrSeriesSnapshot> {
    if (this.type !== 'sonarr' || !Number.isSafeInteger(seriesId) || seriesId <= 0) {
      throw new ArrApiError('A positive Sonarr series ID is required');
    }
    const [episodePayload, filePayload] = await Promise.all([
      this.boundedRequest<unknown>(
        `/episode?seriesId=${seriesId}`,
        SONARR_SERIES_SNAPSHOT_MAX_BYTES,
        'series episode snapshot',
      ),
      this.boundedRequest<unknown>(
        `/episodefile?seriesId=${seriesId}`,
        SONARR_SERIES_SNAPSHOT_MAX_BYTES,
        'series EpisodeFile snapshot',
      ),
    ]);
    if (!Array.isArray(episodePayload) || !Array.isArray(filePayload)) {
      throw new ArrApiError('Sonarr returned an unsupported series snapshot');
    }
    if (
      episodePayload.length > SONARR_SERIES_SNAPSHOT_MAX_RECORDS ||
      filePayload.length > SONARR_SERIES_SNAPSHOT_MAX_RECORDS
    ) {
      throw new ArrApiError(
        `Sonarr series snapshot exceeded the ${SONARR_SERIES_SNAPSHOT_MAX_RECORDS}-record safety limit`,
      );
    }
    const episodeIds = new Set<number>();
    const coordinates = new Set<string>();
    const episodes = episodePayload.map((raw): SonarrSeriesEpisode => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError('Sonarr returned a malformed episode snapshot record');
      }
      const value = raw as Record<string, unknown>;
      const id = Number(value.id);
      const actualSeriesId = Number(value.seriesId);
      const seasonNumber = Number(value.seasonNumber);
      const episodeNumber = Number(value.episodeNumber);
      const episodeFileId = Number(value.episodeFileId ?? 0);
      const coordinate = `${seasonNumber}:${episodeNumber}`;
      if (
        !Number.isSafeInteger(id) || id <= 0 || actualSeriesId !== seriesId ||
        !Number.isSafeInteger(seasonNumber) || seasonNumber < 0 ||
        !Number.isSafeInteger(episodeNumber) || episodeNumber <= 0 ||
        !Number.isSafeInteger(episodeFileId) || episodeFileId < 0 ||
        typeof value.monitored !== 'boolean' || episodeIds.has(id) || coordinates.has(coordinate)
      ) {
        throw new ArrApiError('Sonarr returned conflicting or malformed episode identities');
      }
      episodeIds.add(id);
      coordinates.add(coordinate);
      return {
        id,
        seriesId,
        seasonNumber,
        episodeNumber,
        episodeFileId,
        monitored: value.monitored,
      };
    });
    const owners = new Map<number, number[]>();
    for (const episode of episodes) {
      if (episode.episodeFileId === 0) continue;
      const ids = owners.get(episode.episodeFileId) ?? [];
      ids.push(episode.id);
      owners.set(episode.episodeFileId, ids);
    }
    const fileIds = new Set<number>();
    const files = filePayload.map((raw): SonarrSeriesEpisodeFile => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError('Sonarr returned a malformed EpisodeFile snapshot record');
      }
      const value = raw as Record<string, unknown>;
      const id = Number(value.id);
      const actualSeriesId = Number(value.seriesId);
      const path = typeof value.path === 'string' ? value.path.trim() : '';
      const relativePath = typeof value.relativePath === 'string' ? value.relativePath.trim() : '';
      const size = Number(value.size);
      const normalized = absolutePathComparison(path);
      if (
        !Number.isSafeInteger(id) || id <= 0 || fileIds.has(id) || actualSeriesId !== seriesId ||
        !normalized || !relativePath || !Number.isSafeInteger(size) || size <= 0
      ) {
        throw new ArrApiError('Sonarr returned conflicting or malformed EpisodeFile identities');
      }
      fileIds.add(id);
      return {
        id,
        seriesId,
        path,
        relativePath,
        size,
        episodeIds: [...(owners.get(id) ?? [])].sort((a, b) => a - b),
      };
    });
    if ([...owners.keys()].some((id) => !fileIds.has(id))) {
      throw new ArrApiError('Sonarr episode snapshot references a missing EpisodeFile');
    }
    return { episodes, files };
  }

  async sonarrManualImportPreflight(
    candidates: readonly {
      path: string;
      seriesId: number;
      seasonNumber: number;
      episodeIds: number[];
    }[],
  ): Promise<SonarrManualImportCandidate[]> {
    if (
      this.type !== 'sonarr' || candidates.length === 0 ||
      candidates.length > SONARR_MANUAL_IMPORT_MAX_RECORDS
    ) {
      throw new ArrApiError(
        'Sonarr manual-import preflight candidates are outside the safety bound',
      );
    }
    const payload = candidates.map((candidate) => ({
      path: candidate.path,
      downloadId: '',
      seriesId: candidate.seriesId,
      // Reprocess without caller-selected episode identities. Supplying episodeIds
      // makes Sonarr reapply those choices, so an echoed association would not prove
      // that the retained path is independently recognizable during RescanSeries.
      seasonNumber: null,
      episodeIds: [],
      releaseGroup: '',
      quality: {
        quality: { id: 0, name: 'Unknown', source: 'unknown', resolution: 0 },
        revision: { version: 1, real: 0, isRepack: false },
      },
      languages: [{ id: 0, name: 'Unknown' }],
      indexerFlags: 0,
      releaseType: 'unknown',
    }));
    const result = await this.boundedRequest<unknown>(
      '/manualimport',
      SONARR_SERIES_SNAPSHOT_MAX_BYTES,
      'manual-import preflight response',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    if (!Array.isArray(result) || result.length !== candidates.length) {
      throw new ArrApiError('Sonarr returned an unsupported manual-import preflight response');
    }
    return result.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError('Sonarr returned a malformed manual-import candidate');
      }
      const value = raw as Record<string, unknown>;
      const path = typeof value.path === 'string' ? value.path.trim() : '';
      const size = Number(value.size);
      const series =
        value.series && typeof value.series === 'object' && !Array.isArray(value.series)
          ? value.series as Record<string, unknown>
          : {};
      const seriesId = Number(value.seriesId ?? series.id);
      const seasonNumber = Number(value.seasonNumber);
      const episodes = Array.isArray(value.episodes) ? value.episodes : [];
      const episodeIds = episodes.map((episode) =>
        Number(
          episode && typeof episode === 'object' ? (episode as Record<string, unknown>).id : NaN,
        )
      );
      if (!Array.isArray(value.rejections)) {
        throw new ArrApiError('Sonarr returned malformed manual-import rejection evidence');
      }
      const rejectionReasons = value.rejections.map((rejection) => {
        if (!rejection || typeof rejection !== 'object' || Array.isArray(rejection)) {
          throw new ArrApiError('Sonarr returned malformed manual-import rejection evidence');
        }
        const reason = (rejection as Record<string, unknown>).reason;
        if (typeof reason !== 'string' || !reason.trim()) {
          throw new ArrApiError('Sonarr returned malformed manual-import rejection evidence');
        }
        return reason.trim();
      });
      const quality = value.quality && typeof value.quality === 'object' &&
          !Array.isArray(value.quality)
        ? value.quality as Record<string, unknown>
        : null;
      const qualityValue = quality?.quality && typeof quality.quality === 'object' &&
          !Array.isArray(quality.quality)
        ? quality.quality as Record<string, unknown>
        : null;
      const revision = quality?.revision && typeof quality.revision === 'object' &&
          !Array.isArray(quality.revision)
        ? quality.revision as Record<string, unknown>
        : null;
      const languages = Array.isArray(value.languages)
        ? value.languages.map((language) => {
          const record = language && typeof language === 'object' && !Array.isArray(language)
            ? language as Record<string, unknown>
            : {};
          return { id: Number(record.id), name: String(record.name ?? '').trim() };
        })
        : [];
      const parsedQuality = qualityValue && revision
        ? {
          quality: {
            id: Number(qualityValue.id),
            name: String(qualityValue.name ?? '').trim(),
            source: String(qualityValue.source ?? '').trim(),
            resolution: Number(qualityValue.resolution),
          },
          revision: {
            version: Number(revision.version),
            real: Number(revision.real),
            isRepack: revision.isRepack === true,
          },
        }
        : null;
      const releaseGroup = String(value.releaseGroup ?? '').trim();
      const indexerFlags = Number(value.indexerFlags);
      const releaseType = String(value.releaseType ?? '').trim();
      if (
        absolutePathComparison(path) !== absolutePathComparison(candidates[index]!.path) ||
        !Number.isSafeInteger(size) || size <= 0 || seriesId !== candidates[index]!.seriesId ||
        seasonNumber !== candidates[index]!.seasonNumber ||
        episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(episodeIds).size !== episodeIds.length ||
        !parsedQuality || !Number.isSafeInteger(parsedQuality.quality.id) ||
        !parsedQuality.quality.name || !parsedQuality.quality.source ||
        !Number.isSafeInteger(parsedQuality.quality.resolution) ||
        !Number.isSafeInteger(parsedQuality.revision.version) ||
        !Number.isSafeInteger(parsedQuality.revision.real) || languages.length === 0 ||
        languages.some((language) =>
          !Number.isSafeInteger(language.id) || language.id < 0 || !language.name
        ) || !Number.isSafeInteger(indexerFlags) || indexerFlags < 0 || !releaseType
      ) {
        throw new ArrApiError('Sonarr changed or malformed manual-import preflight identity');
      }
      return {
        path,
        size,
        seriesId,
        seasonNumber,
        episodeIds: [...new Set(episodeIds)].sort((a, b) => a - b),
        quality: parsedQuality,
        languages,
        releaseGroup,
        indexerFlags,
        releaseType,
        rejectionReasons,
      };
    });
  }

  async sonarrManualImport(candidate: SonarrManualImportCandidate): Promise<SonarrCommandEvidence> {
    if (this.type !== 'sonarr' || candidate.rejectionReasons.length > 0) {
      throw new ArrApiError('Only a verified Sonarr manual-import candidate may be submitted');
    }
    const result = await this.request<Record<string, unknown>>('/command', {
      method: 'POST',
      body: JSON.stringify({
        name: 'ManualImport',
        files: [{
          path: candidate.path,
          downloadId: '',
          seriesId: candidate.seriesId,
          seasonNumber: candidate.seasonNumber,
          episodeIds: candidate.episodeIds,
          quality: candidate.quality,
          languages: candidate.languages,
          releaseGroup: candidate.releaseGroup,
          indexerFlags: candidate.indexerFlags,
          releaseType: candidate.releaseType,
        }],
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    return this.parseSonarrCommand(result, 'ManualImport');
  }

  async sonarrManualImportInventory(
    seriesId: number,
    seriesPath: string,
  ): Promise<SonarrUntrackedImportCandidate[]> {
    if (
      this.type !== 'sonarr' || !Number.isSafeInteger(seriesId) || seriesId <= 0 ||
      !absolutePathComparison(seriesPath)
    ) throw new ArrApiError('Exact Sonarr series inventory identity is required');
    const result = await this.boundedRequest<unknown>(
      `/manualimport?folder=${
        encodeURIComponent(seriesPath)
      }&filterExistingFiles=true&seriesId=${seriesId}`,
      SONARR_SERIES_SNAPSHOT_MAX_BYTES,
      'manual-import inventory',
    );
    if (!Array.isArray(result) || result.length > SONARR_MANUAL_IMPORT_MAX_RECORDS) {
      throw new ArrApiError('Sonarr returned an unsupported or oversized manual-import inventory');
    }
    const seen = new Set<string>();
    return result.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError('Sonarr returned a malformed manual-import inventory record');
      }
      const value = raw as Record<string, unknown>;
      const path = String(value.path ?? '').trim();
      const normalized = absolutePathComparison(path);
      const size = Number(value.size);
      const actualSeriesId = Number(
        value.seriesId ??
          (value.series && typeof value.series === 'object'
            ? (value.series as Record<string, unknown>).id
            : NaN),
      );
      const episodeIds = (Array.isArray(value.episodes) ? value.episodes : []).map((episode) =>
        Number(
          episode && typeof episode === 'object' ? (episode as Record<string, unknown>).id : NaN,
        )
      );
      if (!Array.isArray(value.rejections)) {
        throw new ArrApiError(
          'Sonarr returned malformed manual-import inventory rejection evidence',
        );
      }
      const rejectionReasons = value.rejections.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new ArrApiError(
            'Sonarr returned malformed manual-import inventory rejection evidence',
          );
        }
        const reason = (item as Record<string, unknown>).reason;
        if (typeof reason !== 'string' || !reason.trim()) {
          throw new ArrApiError(
            'Sonarr returned malformed manual-import inventory rejection evidence',
          );
        }
        return reason.trim();
      });
      if (
        !normalized || seen.has(normalized) || !Number.isSafeInteger(size) || size <= 0 ||
        actualSeriesId !== seriesId || episodeIds.length === 0 ||
        episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        new Set(episodeIds).size !== episodeIds.length
      ) throw new ArrApiError('Sonarr returned conflicting manual-import inventory identity');
      seen.add(normalized);
      return {
        path,
        size,
        episodeIds: [...new Set(episodeIds)].sort((a, b) => a - b),
        rejectionReasons,
      };
    });
  }

  async sonarrCommand(commandId: number): Promise<SonarrCommandEvidence | null> {
    if (this.type !== 'sonarr' || !Number.isSafeInteger(commandId) || commandId <= 0) {
      throw new ArrApiError('A positive Sonarr command ID is required');
    }
    try {
      return this.parseSonarrCommand(
        await this.request<Record<string, unknown>>(`/command/${commandId}`),
      );
    } catch (error) {
      if (error instanceof ArrApiError && error.status === 404) return null;
      throw error;
    }
  }

  private parseSonarrCommand(
    value: Record<string, unknown>,
    expectedName?: string,
  ): SonarrCommandEvidence {
    const id = Number(value.id);
    const name = String(value.name ?? value.commandName ?? '').trim();
    const status = String(value.status ?? '').trim().toLowerCase();
    if (
      !Number.isSafeInteger(id) || id <= 0 || !name || !status ||
      (expectedName !== undefined && name.toLowerCase() !== expectedName.toLowerCase())
    ) throw new ArrApiError('Sonarr returned malformed command evidence');
    return { id, name, status };
  }

  async sonarrSeriesActivity(
    seriesId: number,
    allowedCommandIds: readonly number[] = [],
  ): Promise<RadarrActivityEvidence> {
    if (this.type !== 'sonarr') throw new ArrApiError('Series activity reads require Sonarr');
    const [queue, commands] = await Promise.all([
      this.boundedRequest<unknown>(
        `/queue?seriesIds=${seriesId}&includeSeries=false&includeEpisode=false&pageSize=${SONARR_ACTIVITY_MAX_RECORDS}`,
        2 * 1024 * 1024,
        'series queue response',
      ),
      this.boundedRequest<unknown>(
        '/command?includeCompleted=false',
        2 * 1024 * 1024,
        'command response',
      ),
    ]);
    const queueObject = queue && typeof queue === 'object' && !Array.isArray(queue)
      ? queue as Record<string, unknown>
      : null;
    const queueRecords = queueObject && Array.isArray(queueObject.records)
      ? queueObject.records
      : null;
    const queueTotal = Number(queueObject?.totalRecords);
    if (
      !queueRecords || !Number.isSafeInteger(queueTotal) || queueTotal < 0 ||
      queueTotal !== queueRecords.length || !Array.isArray(commands) ||
      queueRecords.length > SONARR_ACTIVITY_MAX_RECORDS ||
      commands.length > SONARR_ACTIVITY_MAX_RECORDS
    ) {
      throw new ArrApiError('Sonarr returned unsupported or oversized queue/command evidence');
    }
    const blocking: RadarrActivityEvidence['blocking'] = [];
    for (const raw of queueRecords) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError('Sonarr returned malformed queue activity evidence');
      }
      const value = raw as Record<string, unknown>;
      if (Number(value.seriesId) !== seriesId) {
        throw new ArrApiError('Sonarr returned queue activity outside the requested series');
      }
      const id = Number(value.id);
      blocking.push({
        source: 'queue',
        id: Number.isSafeInteger(id) ? id : 0,
        name: String(value.trackedDownloadStatus ?? value.status ?? 'download/import'),
      });
    }
    const allowed = new Set(allowedCommandIds);
    const blockedNames = /(import|download|search|rescan|refresh|rename|move)/i;
    const terminalCommandStatuses = new Set([
      'completed',
      'failed',
      'aborted',
      'cancelled',
      'canceled',
    ]);
    // These are Sonarr's routine global scheduler shells. They commonly remain in
    // the command list even when they found no work for this series; the scoped queue
    // above is the authoritative evidence for an actual download/import conflict.
    const routineGlobalCommands = new Set([
      'processmonitoreddownloads',
      'refreshmonitoreddownloads',
      'importlistsync',
    ]);
    for (const raw of commands) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError('Sonarr returned malformed command activity evidence');
      }
      const value = raw as Record<string, unknown>;
      const body = value.body && typeof value.body === 'object' && !Array.isArray(value.body)
        ? value.body as Record<string, unknown>
        : {};
      const ids = [
        value.seriesId,
        body.seriesId,
        ...(Array.isArray(value.seriesIds) ? value.seriesIds : []),
        ...(Array.isArray(body.seriesIds) ? body.seriesIds : []),
      ].map(Number).filter(Number.isSafeInteger);
      const name = String(value.name ?? body.name ?? value.commandName ?? '');
      const status = typeof value.status === 'string' ? value.status.trim().toLowerCase() : null;
      const id = Number(value.id);
      if (
        terminalCommandStatuses.has(status ?? '') || !blockedNames.test(name) ||
        routineGlobalCommands.has(name.toLocaleLowerCase('en-US')) ||
        (Number.isSafeInteger(id) && allowed.has(id))
      ) continue;
      // A relevant command without an attributable series boundary may be global or
      // path-scoped. It is unsafe to assume it cannot mutate this series.
      if (ids.length > 0 && !ids.includes(seriesId)) continue;
      blocking.push({ source: 'command', id: Number.isSafeInteger(id) ? id : 0, name });
    }
    return { quiet: blocking.length === 0, blocking };
  }

  async deleteManagedFile(fileId: number): Promise<void> {
    const resource = this.type === 'radarr' ? 'moviefile' : 'episodefile';
    await this.request<void>(`/${resource}/${fileId}`, { method: 'DELETE' });
  }

  async sonarrEpisodeFile(fileId: number): Promise<SonarrSeriesEpisodeFile | null> {
    if (this.type !== 'sonarr' || !Number.isSafeInteger(fileId) || fileId <= 0) {
      throw new ArrApiError('A positive Sonarr EpisodeFile ID is required');
    }
    let value: Record<string, unknown>;
    try {
      value = await this.request<Record<string, unknown>>(`/episodefile/${fileId}`);
    } catch (error) {
      if (error instanceof ArrApiError && error.status === 404) return null;
      throw error;
    }
    const id = Number(value.id);
    const seriesId = Number(value.seriesId);
    const path = typeof value.path === 'string' ? value.path.trim() : '';
    const relativePath = typeof value.relativePath === 'string' ? value.relativePath.trim() : '';
    const size = Number(value.size);
    if (
      id !== fileId || !Number.isSafeInteger(seriesId) || seriesId <= 0 ||
      !absolutePathComparison(path) || !relativePath || !Number.isSafeInteger(size) || size <= 0
    ) {
      throw new ArrApiError('Sonarr returned a malformed EpisodeFile resource');
    }
    return { id, seriesId, path, relativePath, size, episodeIds: [] };
  }

  async sonarrEpisodeFileOwnerIds(fileId: number, seriesId: number): Promise<number[]> {
    if (
      this.type !== 'sonarr' || !Number.isSafeInteger(fileId) || fileId <= 0 ||
      !Number.isSafeInteger(seriesId) || seriesId <= 0
    ) {
      throw new ArrApiError('Positive Sonarr EpisodeFile and series IDs are required');
    }
    const payload = await this.boundedRequest<unknown>(
      `/episode?episodeFileId=${fileId}`,
      2 * 1024 * 1024,
      'EpisodeFile ownership response',
    );
    if (!Array.isArray(payload) || payload.length > SONARR_EPISODE_FILE_OWNER_MAX_RECORDS) {
      throw new ArrApiError('Sonarr returned unsupported or oversized EpisodeFile ownership');
    }
    const ownerIds = new Set<number>();
    for (const raw of payload) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError('Sonarr returned malformed EpisodeFile ownership');
      }
      const record = raw as Record<string, unknown>;
      const id = Number(record.id);
      if (
        !Number.isSafeInteger(id) || id <= 0 || ownerIds.has(id) ||
        Number(record.seriesId) !== seriesId || Number(record.episodeFileId) !== fileId
      ) {
        throw new ArrApiError('Sonarr returned conflicting EpisodeFile ownership');
      }
      ownerIds.add(id);
    }
    return [...ownerIds].sort((left, right) => left - right);
  }

  async rescanMedia(mediaId: number): Promise<void> {
    const body = this.type === 'radarr'
      ? { name: 'RescanMovie', movieId: mediaId }
      : { name: 'RescanSeries', seriesId: mediaId };
    await this.request<void>('/command', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async sonarrRescanSeries(seriesId: number): Promise<SonarrCommandEvidence> {
    if (this.type !== 'sonarr' || !Number.isSafeInteger(seriesId) || seriesId <= 0) {
      throw new ArrApiError('A positive Sonarr series ID is required');
    }
    const result = await this.request<Record<string, unknown>>('/command', {
      method: 'POST',
      body: JSON.stringify({ name: 'RescanSeries', seriesId }),
      headers: { 'Content-Type': 'application/json' },
    });
    return this.parseSonarrCommand(result, 'RescanSeries');
  }

  async monitorTarget(
    mediaId: number,
    episode?: { seasonNumber: number; episodeNumber: number },
  ): Promise<ArrMonitorTarget | null> {
    if (this.type === 'radarr') {
      const record = await this.request<{ id?: number; monitored?: boolean }>(`/movie/${mediaId}`);
      return Number.isInteger(record.id)
        ? { id: record.id!, monitored: record.monitored === true }
        : null;
    }
    if (!episode) throw new ArrApiError('Sonarr episode identity is required');
    const records = await this.request<
      Array<{
        id?: number;
        seasonNumber?: number;
        episodeNumber?: number;
        monitored?: boolean;
      }>
    >(`/episode?seriesId=${mediaId}&seasonNumber=${episode.seasonNumber}`);
    const record = records.find(
      (candidate) =>
        candidate.seasonNumber === episode.seasonNumber &&
        candidate.episodeNumber === episode.episodeNumber,
    );
    return record && Number.isInteger(record.id)
      ? { id: record.id!, monitored: record.monitored === true }
      : null;
  }

  async setMonitorTarget(targetId: number, monitored: boolean): Promise<boolean> {
    const resource = this.type === 'radarr' ? 'movie' : 'episode';
    const record = await this.request<Record<string, unknown> & { monitored?: boolean }>(
      `/${resource}/${targetId}`,
    );
    if (record.monitored === monitored) return false;
    await this.request<void>(`/${resource}/${targetId}`, {
      method: 'PUT',
      body: JSON.stringify({ ...record, monitored }),
      headers: { 'Content-Type': 'application/json' },
    });
    return true;
  }

  async sonarrEpisodeMonitorTarget(
    identity: SonarrEpisodeMonitorIdentity,
  ): Promise<ArrMonitorTarget> {
    if (this.type !== 'sonarr') {
      throw new ArrApiError('Episode monitoring reads require Sonarr');
    }
    if (
      !Number.isSafeInteger(identity.episodeId) ||
      identity.episodeId <= 0 ||
      !Number.isSafeInteger(identity.seriesId) ||
      identity.seriesId <= 0 ||
      !Number.isSafeInteger(identity.seasonNumber) ||
      identity.seasonNumber < 0 ||
      !Number.isSafeInteger(identity.episodeNumber) ||
      identity.episodeNumber <= 0
    ) {
      throw new ArrApiError('Sonarr episode monitoring identity is invalid');
    }
    const record = await this.request<{
      id?: number;
      seriesId?: number;
      seasonNumber?: number;
      episodeNumber?: number;
      monitored?: boolean;
    }>(`/episode/${identity.episodeId}`);
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      record.id !== identity.episodeId ||
      record.seriesId !== identity.seriesId ||
      record.seasonNumber !== identity.seasonNumber ||
      record.episodeNumber !== identity.episodeNumber ||
      typeof record.monitored !== 'boolean'
    ) {
      throw new ArrApiError('Sonarr returned a conflicting or malformed targeted episode');
    }
    return { id: identity.episodeId, monitored: record.monitored };
  }

  private async radarrMovieMonitorResource(
    identity: RadarrMovieMonitorIdentity,
  ): Promise<Record<string, unknown> & { id: number; monitored: boolean }> {
    if (this.type !== 'radarr') {
      throw new ArrApiError('Movie monitoring reads require Radarr');
    }
    if (
      !Number.isSafeInteger(identity.movieId) ||
      identity.movieId <= 0 ||
      !Number.isSafeInteger(identity.tmdbId) ||
      identity.tmdbId <= 0 ||
      typeof identity.path !== 'string' ||
      identity.path.trim().length === 0 ||
      identity.path.trim() !== identity.path
    ) {
      throw new ArrApiError('Radarr movie monitoring identity is invalid');
    }
    const record = await this.request<
      Record<string, unknown> & {
        id?: number;
        tmdbId?: number;
        path?: string;
        monitored?: boolean;
      }
    >(`/movie/${identity.movieId}`);
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      record.id !== identity.movieId ||
      record.tmdbId !== identity.tmdbId ||
      typeof record.path !== 'string' ||
      record.path.trim() !== identity.path ||
      typeof record.monitored !== 'boolean'
    ) {
      throw new ArrApiError('Radarr returned a conflicting or malformed targeted movie');
    }
    return record as Record<string, unknown> & {
      id: number;
      monitored: boolean;
    };
  }

  async radarrMovieMonitorTarget(identity: RadarrMovieMonitorIdentity): Promise<ArrMonitorTarget> {
    const record = await this.radarrMovieMonitorResource(identity);
    return { id: identity.movieId, monitored: record.monitored };
  }

  async setSonarrEpisodeMonitored(
    identity: SonarrEpisodeMonitorIdentity,
    monitored: boolean,
  ): Promise<boolean> {
    const before = await this.sonarrEpisodeMonitorTarget(identity);
    if (before.monitored === monitored) return false;
    let writeError: unknown;
    try {
      await this.request<void>(`/episode/${identity.episodeId}`, {
        method: 'PUT',
        body: JSON.stringify({ id: identity.episodeId, monitored }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      writeError = error;
    }
    let after: ArrMonitorTarget;
    try {
      after = await this.sonarrEpisodeMonitorTarget(identity);
    } catch (error) {
      throw new ArrApiError(
        `Sonarr episode monitoring read-back was inconclusive: ${
          error instanceof Error ? error.message : 'request failed'
        }`,
        undefined,
        true,
      );
    }
    if (after.monitored === monitored) return true;
    if (writeError) throw writeError;
    throw new ArrApiError('Sonarr episode monitoring update did not converge');
  }

  async setRadarrMovieMonitored(
    identity: RadarrMovieMonitorIdentity,
    monitored: boolean,
  ): Promise<boolean> {
    const before = await this.radarrMovieMonitorResource(identity);
    if (before.monitored === monitored) return false;
    let writeError: unknown;
    try {
      await this.request<void>(`/movie/${identity.movieId}?moveFiles=false`, {
        method: 'PUT',
        body: JSON.stringify({ ...before, monitored }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      writeError = error;
    }
    let after: Record<string, unknown> & { id: number; monitored: boolean };
    try {
      after = await this.radarrMovieMonitorResource(identity);
    } catch (error) {
      throw new ArrApiError(
        `Radarr movie monitoring read-back was inconclusive: ${
          error instanceof Error ? error.message : 'request failed'
        }`,
        undefined,
        true,
      );
    }
    if (after.monitored === monitored) {
      assertOnlyRadarrMovieChanges(before, after, ['monitored']);
      return true;
    }
    if (writeError) throw writeError;
    throw new ArrApiError('Radarr movie monitoring update did not converge');
  }

  async radarrImmediateChildren(path: string): Promise<RadarrFilesystemEntry[]> {
    if (this.type !== 'radarr') {
      throw new ArrApiError('Filesystem enumeration requires Radarr');
    }
    const records = await this.boundedRequest<unknown>(
      `/filesystem?path=${encodeURIComponent(path)}&includeFiles=true`,
      RADARR_FILESYSTEM_MAX_BYTES,
      'filesystem response',
    );
    if (!Array.isArray(records)) {
      throw new ArrApiError('Radarr returned an unsupported filesystem response');
    }
    if (records.length > RADARR_FILESYSTEM_MAX_ENTRIES) {
      throw new ArrApiError(
        `Radarr filesystem response exceeded the ${RADARR_FILESYSTEM_MAX_ENTRIES}-entry safety limit`,
      );
    }
    const requested = radarrPathComparison(path);
    return records.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError('Radarr returned a malformed filesystem entry');
      }
      const record = raw as Record<string, unknown>;
      const childPath = typeof record.path === 'string' ? record.path.trim() : '';
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const type = String(record.type ?? '').toLowerCase();
      if (!childPath || !name || (type !== 'file' && type !== 'folder')) {
        throw new ArrApiError('Radarr returned an incomplete filesystem entry');
      }
      const normalizedChild = childPath.trim().replaceAll('\\', '/').replace(/\/+$/, '');
      const childParent = normalizedChild.slice(0, normalizedChild.lastIndexOf('/'));
      const childName = normalizedChild.slice(normalizedChild.lastIndexOf('/') + 1);
      if (
        radarrPathComparison(childParent) !== requested ||
        childName.toLocaleLowerCase('en-US') !== name.toLocaleLowerCase('en-US')
      ) {
        throw new ArrApiError('Radarr returned a non-immediate or conflicting filesystem entry');
      }
      return { path: childPath, name, type } as RadarrFilesystemEntry;
    });
  }

  async radarrRootFolders(): Promise<RadarrRootFolder[]> {
    if (this.type !== 'radarr') throw new ArrApiError('Root-folder reads require Radarr');
    const records = await this.boundedRequest<unknown>(
      '/rootfolder',
      RADARR_FILESYSTEM_MAX_BYTES,
      'root-folder response',
    );
    if (!Array.isArray(records) || records.length > 1_000) {
      throw new ArrApiError('Radarr returned an unsupported root-folder response');
    }
    return records.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError('Radarr returned a malformed root-folder record');
      }
      const record = raw as Record<string, unknown>;
      const id = Number(record.id);
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      if (!Number.isSafeInteger(id) || id <= 0 || !path) {
        throw new ArrApiError('Radarr returned an incomplete root-folder record');
      }
      return { id, path };
    });
  }

  async radarrMovieCatalogPaths(): Promise<RadarrCatalogMoviePath[]> {
    if (this.type !== 'radarr') throw new ArrApiError('Movie-catalog reads require Radarr');
    const records = await this.boundedRequest<unknown>(
      '/movie',
      RADARR_CATALOG_MAX_BYTES,
      'movie catalog',
    );
    if (!Array.isArray(records)) throw new ArrApiError('Radarr returned an invalid movie catalog');
    if (records.length > RADARR_CATALOG_MAX_RECORDS) {
      throw new ArrApiError(
        `Radarr movie catalog exceeded the ${RADARR_CATALOG_MAX_RECORDS}-record safety limit`,
      );
    }
    return records.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError('Radarr returned a malformed movie catalog record');
      }
      const record = raw as Record<string, unknown>;
      const id = Number(record.id);
      const tmdbId = Number(record.tmdbId);
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        !Number.isSafeInteger(tmdbId) ||
        tmdbId <= 0 ||
        !path
      ) {
        throw new ArrApiError('Radarr returned an incomplete movie catalog record');
      }
      return { id, tmdbId, path };
    });
  }

  async radarrPathAdoptionCapabilities(): Promise<RadarrPathAdoptionCapabilities> {
    if (this.type !== 'radarr') {
      return {
        available: false,
        version: null,
        minimumVersion: RADARR_PATH_ADOPTION_MIN_VERSION,
        behaviorFingerprint: null,
        behavior: null,
        reason: 'Path adoption requires Radarr',
      };
    }
    const status = await this.request<{ version?: string; appName?: string }>('/system/status');
    const version = typeof status.version === 'string' ? status.version.trim() : null;
    if (!version || !versionAtLeast(version, RADARR_PATH_ADOPTION_MIN_VERSION)) {
      return {
        available: false,
        version,
        minimumVersion: RADARR_PATH_ADOPTION_MIN_VERSION,
        behaviorFingerprint: null,
        behavior: null,
        reason: version
          ? `Radarr ${RADARR_PATH_ADOPTION_MIN_VERSION} or newer is required for retained-path adoption; this instance reports ${version}`
          : `Radarr version could not be verified; ${RADARR_PATH_ADOPTION_MIN_VERSION} or newer is required for retained-path adoption`,
      };
    }
    const [mediaManagement, metadata, notifications] = await Promise.all([
      this.request<Record<string, unknown>>('/config/mediamanagement'),
      this.boundedRequest<unknown[]>('/metadata', 2 * 1024 * 1024, 'metadata-consumer response'),
      this.boundedRequest<unknown[]>(
        '/notification',
        2 * 1024 * 1024,
        'notification-consumer response',
      ),
    ]);
    if (!Array.isArray(metadata) || !Array.isArray(notifications)) {
      throw new ArrApiError('Radarr returned unsupported behavior configuration');
    }
    const behavior = {
      autoUnmonitorPreviouslyDownloadedMovies:
        mediaManagement.autoUnmonitorPreviouslyDownloadedMovies === true,
      deleteEmptyFolders: mediaManagement.deleteEmptyFolders === true,
      fileDate: String(mediaManagement.fileDate ?? 'unknown'),
      rescanAfterRefresh: String(mediaManagement.rescanAfterRefresh ?? 'unknown'),
      metadataConsumerCount: metadata.filter(
        (entry) =>
          entry && typeof entry === 'object' && (entry as Record<string, unknown>).enable !== false,
      ).length,
      notificationConsumerCount: notifications.filter(
        (entry) =>
          entry && typeof entry === 'object' && (entry as Record<string, unknown>).enable !== false,
      ).length,
    };
    return {
      available: true,
      version,
      minimumVersion: RADARR_PATH_ADOPTION_MIN_VERSION,
      behaviorFingerprint: await sha256({ version, behavior }),
      behavior,
    };
  }

  async radarrMovieActivity(
    movieId: number,
    allowedCommandIds: readonly number[] = [],
  ): Promise<RadarrActivityEvidence> {
    if (this.type !== 'radarr') throw new ArrApiError('Activity reads require Radarr');
    const [queue, commands] = await Promise.all([
      this.boundedRequest<unknown>(
        `/queue?movieIds=${movieId}&includeMovie=true&pageSize=100`,
        2 * 1024 * 1024,
        'queue response',
      ),
      this.boundedRequest<unknown>(
        '/command?includeCompleted=false',
        2 * 1024 * 1024,
        'command response',
      ),
    ]);
    const queueRecords = queue &&
        typeof queue === 'object' &&
        !Array.isArray(queue) &&
        Array.isArray((queue as Record<string, unknown>).records)
      ? (queue as { records: unknown[] }).records
      : null;
    if (!queueRecords || !Array.isArray(commands)) {
      throw new ArrApiError('Radarr returned unsupported queue or command evidence');
    }
    const blocking: RadarrActivityEvidence['blocking'] = [];
    for (const raw of queueRecords) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      if (Number(record.movieId) !== movieId) continue;
      const id = Number(record.id);
      blocking.push({
        source: 'queue',
        id: Number.isSafeInteger(id) ? id : 0,
        name: String(record.trackedDownloadStatus ?? record.status ?? 'download/import'),
      });
    }
    const allowedCommands = new Set(allowedCommandIds);
    const blockedNames = /(import|download|search|rescan|refresh|rename|move)/i;
    for (const raw of commands) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const body = record.body && typeof record.body === 'object' && !Array.isArray(record.body)
        ? (record.body as Record<string, unknown>)
        : {};
      const commandMovieIds = [
        record.movieId,
        body.movieId,
        ...(Array.isArray(record.movieIds) ? record.movieIds : []),
        ...(Array.isArray(body.movieIds) ? body.movieIds : []),
      ].map(Number).filter(Number.isSafeInteger);
      const name = String(record.name ?? body.name ?? record.commandName ?? '');
      const id = Number(record.id);
      if (
        !commandMovieIds.includes(movieId) ||
        !blockedNames.test(name) ||
        (Number.isSafeInteger(id) && allowedCommands.has(id))
      ) {
        continue;
      }
      blocking.push({
        source: 'command',
        id: Number.isSafeInteger(id) ? id : 0,
        name,
      });
    }
    return { quiet: blocking.length === 0, blocking };
  }

  async startRadarrRescan(movieId: number): Promise<{ id: number; status: string }> {
    if (this.type !== 'radarr') throw new ArrApiError('Targeted movie rescans require Radarr');
    const record = await this.request<{ id?: number; status?: string }>('/command', {
      method: 'POST',
      body: JSON.stringify({ name: 'RescanMovie', movieId }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!Number.isSafeInteger(record.id) || record.id! <= 0 || typeof record.status !== 'string') {
      throw new ArrApiError('Radarr returned an invalid rescan command');
    }
    return { id: record.id!, status: record.status };
  }

  async radarrCommand(
    commandId: number,
  ): Promise<{ id: number; status: string; message: string | null }> {
    if (this.type !== 'radarr') throw new ArrApiError('Command reads require Radarr');
    const record = await this.request<{
      id?: number;
      status?: string;
      message?: string | null;
    }>(`/command/${commandId}`);
    if (record.id !== commandId || typeof record.status !== 'string') {
      throw new ArrApiError('Radarr returned a conflicting rescan command');
    }
    return {
      id: commandId,
      status: record.status,
      message: typeof record.message === 'string' ? record.message : null,
    };
  }

  async updateRadarrMoviePath(
    identity: RadarrMovieMonitorIdentity,
    targetPath: string,
  ): Promise<RadarrMoviePathUpdateResult> {
    const before = (await this.radarrMovieMonitorResource(
      identity,
    )) as RadarrMoviePathUpdateResult['before'];
    if (
      radarrPathComparison(before.path) === radarrPathComparison(targetPath) &&
      !before.monitored
    ) {
      return { before, after: before, changed: false };
    }
    const intended = { ...before, path: targetPath, monitored: false };
    let writeError: unknown;
    try {
      await this.request<void>(`/movie/${identity.movieId}?moveFiles=false`, {
        method: 'PUT',
        body: JSON.stringify(intended),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      writeError = error;
    }
    let after: RadarrMoviePathUpdateResult['after'];
    try {
      const raw = await this.request<
        Record<string, unknown> & {
          id?: number;
          tmdbId?: number;
          path?: string;
          monitored?: boolean;
        }
      >(`/movie/${identity.movieId}`);
      if (
        raw.id !== identity.movieId ||
        raw.tmdbId !== identity.tmdbId ||
        typeof raw.path !== 'string' ||
        typeof raw.monitored !== 'boolean'
      ) {
        throw new Error('conflicting targeted movie');
      }
      after = raw as RadarrMoviePathUpdateResult['after'];
    } catch (error) {
      throw new ArrApiError(
        `Radarr movie path read-back was inconclusive: ${
          error instanceof Error ? error.message : 'request failed'
        }`,
        undefined,
        true,
      );
    }
    const converged = radarrPathComparison(after.path) === radarrPathComparison(targetPath) &&
      after.monitored === false;
    if (!converged) {
      if (writeError) throw writeError;
      throw new ArrApiError('Radarr movie path update did not converge');
    }
    assertOnlyRadarrMovieChanges(before, after, ['path', 'monitored']);
    return { before, after, changed: true };
  }

  async torrentAssociations(mediaId: number): Promise<ArrTorrentAssociation[]> {
    const path = this.type === 'radarr'
      ? `/history/movie?movieId=${mediaId}&includeMovie=false`
      : `/history/series?seriesId=${mediaId}&includeSeries=false&includeEpisode=false`;
    const payload = await this.boundedRequest<unknown>(
      path,
      ARR_HISTORY_MAX_BYTES,
      'download history response',
    );
    if (!Array.isArray(payload) || payload.length > ARR_HISTORY_MAX_RECORDS) {
      throw new ArrApiError('Arr returned unsupported or oversized download history evidence');
    }
    const records = payload as Array<{
      id?: number;
      date?: string;
      eventType?: string;
      downloadId?: string;
      data?: {
        droppedPath?: string;
        sourcePath?: string;
        importedPath?: string;
      };
    }>;
    const associations = new Map<string, ArrTorrentAssociation>();
    for (const record of records) {
      if (record.eventType?.toLowerCase() !== 'downloadfolderimported') continue;
      const hash = record.downloadId?.trim().toLowerCase();
      // BitTorrent v1 hashes are 40 hex characters; v2 hashes are 64. Anything else
      // may be a Usenet download ID and must never be sent to qBittorrent.
      if (!hash || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) continue;
      const droppedPath = record.data?.droppedPath?.trim() || null;
      const historySourcePath = record.data?.sourcePath?.trim() || null;
      const sourcePath = droppedPath || historySourcePath;
      // downloadFolderImported commonly exposes the exact imported file as
      // droppedPath and the release/payload root as sourcePath. Keep both: the file
      // proves the primary hardlink while the root bounds recursive sidecar checks.
      const payloadPath = droppedPath && historySourcePath ? historySourcePath : null;
      const importedPath = record.data?.importedPath?.trim() || null;
      associations.set(`${hash}:${sourcePath ?? ''}:${payloadPath ?? ''}:${importedPath ?? ''}`, {
        hash,
        sourcePath,
        payloadPath,
        importedPath,
        historyId: Number.isInteger(record.id) ? record.id! : null,
        date: record.date?.trim() || null,
      });
    }
    return [...associations.values()];
  }

  async downloadIdIsExclusiveTo(mediaId: number | null, hash: string): Promise<boolean> {
    const pageSize = 100;
    const maxRecords = 1_000;
    for (let page = 1; page <= Math.ceil(maxRecords / pageSize); page++) {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sortKey: 'date',
        sortDirection: 'descending',
        downloadId: hash,
      });
      const response = await this.request<{
        totalRecords?: number;
        records?: Array<{ movieId?: number; seriesId?: number }>;
      }>(`/history?${params}`);
      if (
        !Array.isArray(response.records) ||
        !Number.isInteger(response.totalRecords) ||
        response.totalRecords! < 0
      ) {
        throw new ArrApiError('Arr returned an invalid download history response');
      }
      if (response.totalRecords! > maxRecords) return false;
      for (const record of response.records) {
        const recordMediaId = this.type === 'radarr' ? record.movieId : record.seriesId;
        if (!Number.isInteger(recordMediaId) || mediaId === null || recordMediaId !== mediaId) {
          return false;
        }
      }
      if (page * pageSize >= response.totalRecords!) return true;
    }
    return false;
  }

  async deleteMedia(id: number, addImportExclusion: boolean): Promise<void> {
    const resource = this.type === 'radarr' ? 'movie' : 'series';
    const exclusionParam = this.type === 'radarr' ? 'addImportExclusion' : 'addImportListExclusion';
    await this.request<void>(
      `/${resource}/${id}?deleteFiles=true&${exclusionParam}=${addImportExclusion}`,
      { method: 'DELETE' },
    );
  }

  async radarrImportExclusions(): Promise<RadarrImportExclusion[]> {
    if (this.type !== 'radarr') throw new ArrApiError('Import exclusions require Radarr');
    const records: unknown[] = [];
    for (let page = 1; page <= 50; page++) {
      const raw = await this.boundedRequest<unknown>(
        `/exclusions/paged?page=${page}&pageSize=1000&sortKey=movieTitle&sortDirection=ascending`,
        4 * 1024 * 1024,
        'import exclusion response',
      );
      if (
        !raw || typeof raw !== 'object' || !Array.isArray((raw as { records?: unknown }).records)
      ) {
        throw new ArrApiError('Radarr returned malformed import exclusions');
      }
      const response = raw as { records: unknown[]; totalRecords?: unknown };
      records.push(...response.records);
      const totalRecords = Number(response.totalRecords);
      if (
        response.records.length < 1000 ||
        (Number.isSafeInteger(totalRecords) && totalRecords >= 0 && records.length >= totalRecords)
      ) break;
      if (page === 50) throw new ArrApiError('Radarr import exclusion read exceeded its bound');
    }
    return records.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ArrApiError('Radarr returned malformed import exclusion evidence');
      }
      const record = value as Record<string, unknown>;
      const id = Number(record.id);
      const tmdbId = Number(record.tmdbId);
      const movieYear = Number(record.movieYear);
      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        !Number.isSafeInteger(tmdbId) ||
        tmdbId <= 0 ||
        typeof record.movieTitle !== 'string' ||
        record.movieTitle.trim().length === 0 ||
        !Number.isSafeInteger(movieYear) ||
        movieYear <= 0
      ) {
        throw new ArrApiError('Radarr returned malformed import exclusion evidence');
      }
      return { id, tmdbId, movieTitle: record.movieTitle, movieYear };
    });
  }

  async createRadarrImportExclusion(input: {
    tmdbId: number;
    movieTitle: string;
    movieYear: number;
  }): Promise<RadarrImportExclusion> {
    if (this.type !== 'radarr') throw new ArrApiError('Import exclusions require Radarr');
    const record = await this.request<Record<string, unknown>>('/exclusions', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
    });
    const id = Number(record.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ArrApiError('Radarr returned a malformed created import exclusion');
    }
    return { id, ...input };
  }

  async removeRadarrMovieWithoutFiles(movieId: number): Promise<void> {
    if (this.type !== 'radarr') throw new ArrApiError('Movie removal requires Radarr');
    await this.request<void>(`/movie/${movieId}?deleteFiles=false&addImportExclusion=true`, {
      method: 'DELETE',
    });
  }
}
