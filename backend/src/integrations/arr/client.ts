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
  /** Sonarr import history ownership; absent when unavailable or malformed. */
  episodeId?: number;
  /** Imported Sonarr file ID from history data, not the episode's current file. */
  episodeFileId?: number;
  /** Imported Radarr file ID from its history data, never the current catalog file. */
  movieFileId?: number;
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
export const ARR_ROOT_FOLDERS_MAX_BYTES = 2 * 1024 * 1024;
export const ARR_ROOT_FOLDERS_MAX_RECORDS = 1_000;
export const SONARR_SEASON_COORDINATION_MIN_VERSION = '4.0.19.2979';
export const SONARR_SERIES_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const SONARR_SERIES_SNAPSHOT_MAX_RECORDS = 50_000;
export const SONARR_ACTIVITY_MAX_RECORDS = 1_000;
export const SONARR_MANUAL_IMPORT_MAX_RECORDS = 500;

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

export interface ArrRootFolder {
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
    readonly deletionRejected = false,
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

export function versionAtLeast(actual: string, minimum: string): boolean {
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

export function supportedRadarrPathAdoptionVersion(actual: string): boolean {
  const major = /^(\d+)\./.exec(actual.trim());
  return major?.[1] === '6' && versionAtLeast(actual, RADARR_PATH_ADOPTION_MIN_VERSION);
}

function absolutePathComparison(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed !== path) return null;
  const unix = trimmed.startsWith('/');
  const windows = /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(trimmed);
  if (!unix && !windows) return null;
  return trimmed.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US');
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

  private async request<T>(
    path: string,
    init?: RequestInit,
    onResponse?: (status: number) => void,
    responseShape?: 'resource',
  ): Promise<T> {
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

    if (response.status === 204) {
      onResponse?.(response.status);
      return undefined as T;
    }
    const text = await response.text();
    const result = text ? (JSON.parse(text) as T) : (undefined as T);
    if (onResponse && text && (!result || typeof result !== 'object')) {
      throw new ArrApiError(
        'The media manager returned an ambiguous deletion response',
        response.status,
      );
    }
    if (onResponse && result && typeof result === 'object') {
      const body = result as Record<string, unknown>;
      if (
        body.error || body.errorMessage ||
        body.errors && (!Array.isArray(body.errors) || body.errors.length > 0) ||
        ['failed', 'error', 'aborted'].includes(String(body.status).toLowerCase())
      ) {
        throw new ArrApiError(
          'The media manager rejected the deletion request',
          response.status,
          false,
          true,
        );
      }
      if (
        Array.isArray(result) || body.error || body.errors || body.errorMessage ||
        ['failed', 'error', 'aborted'].includes(String(body.status).toLowerCase()) ||
        responseShape !== 'resource' && Object.keys(body).length > 0 && !(response.status === 202 &&
            Number.isSafeInteger(body.id) && Number(body.id) > 0 &&
            ['queued', 'started', 'pending', 'completed'].includes(
              String(body.status).toLowerCase(),
            ))
      ) {
        throw new ArrApiError(
          'The media manager returned a failed or ambiguous deletion response',
          response.status,
        );
      }
    }
    onResponse?.(response.status);
    return result;
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

  async extraFiles(mediaId: number): Promise<ArrExtraFile[]> {
    if (this.type !== 'radarr') return [];
    if (!Number.isSafeInteger(mediaId) || mediaId <= 0) {
      throw new ArrApiError('A positive Radarr movie ID is required');
    }
    const records = await this.boundedRequest<
      Array<{
        relativePath?: string;
        type?: number | string;
        movieFileId?: number | null;
      }>
    >(`/extrafile?movieId=${mediaId}`, RADARR_CATALOG_MAX_BYTES, 'extra-file inventory');
    if (!Array.isArray(records) || records.length > RADARR_CATALOG_MAX_RECORDS) {
      throw new ArrApiError('Radarr returned an invalid extra-file response');
    }
    return records.flatMap((record) => {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        throw new ArrApiError('Radarr returned an invalid extra-file record');
      }
      const relativePath = typeof record.relativePath === 'string'
        ? record.relativePath.trim()
        : '';
      if (
        !relativePath || relativePath !== record.relativePath ||
        [...relativePath].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        /^[\\/]|^[a-z]:/i.test(relativePath) ||
        relativePath.replaceAll('\\', '/').split('/').some((part) =>
          !part || part === '.' || part === '..'
        )
      ) {
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

  async deleteManagedFile(
    fileId: number,
    onResponse?: (
      result: import('../../../../shared/serviceStorage.ts').ServiceDeletionResponse,
    ) => void,
  ): Promise<void> {
    const resource = this.type === 'radarr' ? 'moviefile' : 'episodefile';
    await this.request<void>(
      `/${resource}/${fileId}`,
      { method: 'DELETE' },
      (httpStatus) =>
        onResponse?.({ status: httpStatus === 202 ? 'accepted' : 'succeeded', httpStatus }),
    );
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

  async sonarrEpisodeMonitorTarget(
    identity: SonarrEpisodeMonitorIdentity,
    requireFileAbsent = false,
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
      episodeFileId?: number;
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
    if (requireFileAbsent && record.episodeFileId !== 0) {
      throw new ArrApiError('Sonarr episode has a current or unverified file; monitoring is held');
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

  async setSonarrEpisodeMonitored(
    identity: SonarrEpisodeMonitorIdentity,
    monitored: boolean,
    onResponse?: (
      result: import('../../../../shared/serviceStorage.ts').ServiceDeletionResponse,
    ) => void,
    requireFileAbsent = false,
  ): Promise<boolean> {
    const before = await this.sonarrEpisodeMonitorTarget(identity, requireFileAbsent);
    if (before.monitored === monitored) return false;
    let writeError: unknown;
    try {
      await this.request<void>(
        `/episode/${identity.episodeId}`,
        {
          method: 'PUT',
          body: JSON.stringify({ id: identity.episodeId, monitored }),
          headers: { 'Content-Type': 'application/json' },
        },
        (httpStatus) =>
          onResponse?.({ status: httpStatus === 202 ? 'accepted' : 'succeeded', httpStatus }),
        'resource',
      );
    } catch (error) {
      writeError = error;
    }
    let after: ArrMonitorTarget;
    try {
      after = await this.sonarrEpisodeMonitorTarget(identity, requireFileAbsent);
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

  async rootFolders(): Promise<ArrRootFolder[]> {
    const records = await this.boundedRequest<unknown>(
      '/rootfolder',
      ARR_ROOT_FOLDERS_MAX_BYTES,
      'root-folder response',
    );
    if (!Array.isArray(records) || records.length > ARR_ROOT_FOLDERS_MAX_RECORDS) {
      throw new ArrApiError(
        `${
          this.type === 'radarr' ? 'Radarr' : 'Sonarr'
        } returned an unsupported root-folder response`,
      );
    }
    return records.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ArrApiError(
          `${this.type === 'radarr' ? 'Radarr' : 'Sonarr'} returned a malformed root-folder record`,
        );
      }
      const record = raw as Record<string, unknown>;
      const id = Number(record.id);
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      if (!Number.isSafeInteger(id) || id <= 0 || !path) {
        throw new ArrApiError(
          `${
            this.type === 'radarr' ? 'Radarr' : 'Sonarr'
          } returned an incomplete root-folder record`,
        );
      }
      return { id, path };
    });
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
      episodeId?: unknown;
      date?: string;
      eventType?: string;
      downloadId?: string;
      data?: {
        droppedPath?: string;
        sourcePath?: string;
        importedPath?: string;
        fileId?: unknown;
        FileId?: unknown;
      };
    }>;
    const associations = new Map<string, ArrTorrentAssociation>();
    for (const record of records) {
      if (
        !record || typeof record !== 'object' || Array.isArray(record) ||
        record.eventType !== undefined && typeof record.eventType !== 'string'
      ) throw new ArrApiError('Arr returned malformed download history evidence');
      if (record.eventType?.toLowerCase() !== 'downloadfolderimported') continue;
      if (
        record.data !== undefined &&
        (!record.data || typeof record.data !== 'object' || Array.isArray(record.data))
      ) throw new ArrApiError('Arr returned malformed download history ownership');
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
      const episodeId = this.type === 'sonarr' &&
          typeof record.episodeId === 'number' && Number.isSafeInteger(record.episodeId) &&
          record.episodeId > 0
        ? record.episodeId
        : undefined;
      // Both Arr HistoryService implementations store FileId as a decimal string
      // from the imported file ID in the history data dictionary.
      // Accept the serialized camel-case key and the original dictionary key, but
      // never select one of conflicting values or coerce malformed IDs.
      const fileIds = [record.data?.fileId, record.data?.FileId]
        .filter((value) => value !== undefined);
      const importedFileId = fileIds.length > 0 &&
          fileIds.every((value) =>
            typeof value === 'string' && /^[1-9]\d*$/.test(value) &&
            Number.isSafeInteger(Number(value)) && value === fileIds[0]
          )
        ? Number(fileIds[0])
        : undefined;
      if (this.type === 'radarr' && fileIds.length > 0 && importedFileId === undefined) {
        throw new ArrApiError('Radarr returned malformed or conflicting imported file ownership');
      }
      const episodeFileId = this.type === 'sonarr' ? importedFileId : undefined;
      const movieFileId = this.type === 'radarr' ? importedFileId : undefined;
      const key = JSON.stringify([
        hash,
        sourcePath,
        payloadPath,
        importedPath,
        episodeId,
        episodeFileId,
        movieFileId,
      ]);
      associations.set(key, {
        hash,
        sourcePath,
        payloadPath,
        importedPath,
        historyId: Number.isInteger(record.id) ? record.id! : null,
        date: record.date?.trim() || null,
        ...(episodeId === undefined ? {} : { episodeId }),
        ...(episodeFileId === undefined ? {} : { episodeFileId }),
        ...(movieFileId === undefined ? {} : { movieFileId }),
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

  async deleteMedia(
    id: number,
    addImportExclusion: boolean,
    onResponse?: (
      result: import('../../../../shared/serviceStorage.ts').ServiceDeletionResponse,
    ) => void,
  ): Promise<void> {
    const resource = this.type === 'radarr' ? 'movie' : 'series';
    const exclusionParam = this.type === 'radarr' ? 'addImportExclusion' : 'addImportListExclusion';
    let httpStatus = 0;
    await this.request<void>(
      `/${resource}/${id}?deleteFiles=true&${exclusionParam}=${addImportExclusion}`,
      { method: 'DELETE' },
      (status) => {
        httpStatus = status;
      },
    );
    onResponse?.({ status: httpStatus === 202 ? 'accepted' : 'succeeded', httpStatus });
  }

  /** Remove only the service catalog entry after separately authorized file actions. */
  async deleteManagedRecord(
    id: number,
    addImportExclusion: boolean,
    onResponse?: (
      result: import('../../../../shared/serviceStorage.ts').ServiceDeletionResponse,
    ) => void,
  ): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ArrApiError('A positive managed record ID is required');
    }
    const resource = this.type === 'radarr' ? 'movie' : 'series';
    const exclusionParam = this.type === 'radarr' ? 'addImportExclusion' : 'addImportListExclusion';
    await this.request<void>(
      `/${resource}/${id}?deleteFiles=false&${exclusionParam}=${addImportExclusion}`,
      { method: 'DELETE' },
      (httpStatus) =>
        onResponse?.({ status: httpStatus === 202 ? 'accepted' : 'succeeded', httpStatus }),
    );
  }

  async remotePathHints(): Promise<Array<{ host: string; remotePath: string; localPath: string }>> {
    const raw = await this.boundedRequest<unknown>(
      '/remotepathmapping',
      1024 * 1024,
      'remote mapping hints',
    );
    if (!Array.isArray(raw) || raw.length > 1000) {
      throw new ArrApiError('Invalid remote mapping hints');
    }
    return raw.flatMap((row) =>
      typeof row?.host === 'string' && row.host.trim() &&
        typeof row.remotePath === 'string' && row.remotePath.trim() &&
        typeof row.localPath === 'string' && row.localPath.trim()
        ? [{ host: row.host.trim(), remotePath: row.remotePath, localPath: row.localPath }]
        : []
    );
  }
}
