import type { ArrType } from '@plex-librarian/shared/types.ts';

export interface ArrMediaRecord {
  id: number;
  title: string;
  path: string | null;
  seasons: ArrSeasonSummary[] | null;
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

export interface ArrManagedFile {
  relativePath: string;
  size: number | null;
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
          'Accept': 'application/json',
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
    return text ? JSON.parse(text) as T : undefined as T;
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
        path?: string;
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
      record === null || typeof record !== 'object' || Array.isArray(record) ||
      !Number.isInteger(record.id) || record.id <= 0
    ) {
      throw new ArrApiError(
        `${this.type === 'radarr' ? 'Radarr' : 'Sonarr'} returned an invalid managed record`,
      );
    }
    return {
      id: record.id,
      title: record.title ?? String(record.id),
      path: record.path?.trim() || null,
      seasons: this.type === 'sonarr'
        ? (record.seasons ?? []).flatMap((season) => {
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
          return [{ seasonNumber, episodeFileCount, size } satisfies ArrSeasonSummary];
        }).sort((a, b) => a.seasonNumber - b.seasonNumber)
        : null,
    };
  }

  async extraFiles(mediaId: number): Promise<ArrExtraFile[]> {
    if (this.type !== 'radarr') return [];
    const records = await this.request<
      Array<{ relativePath?: string; type?: number | string; movieFileId?: number | null }>
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
      if (
        movieFileId !== null &&
        (!Number.isInteger(movieFileId) || movieFileId <= 0)
      ) {
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
      !record || typeof record !== 'object' || Array.isArray(record) ||
      !Number.isInteger(record.id) || record.id !== mediaId || !path
    ) throw new ArrApiError('Radarr returned an invalid targeted movie record');
    return { id: mediaId, path };
  }

  async fileVisibility(path: string): Promise<'file' | 'folder'> {
    if (this.type !== 'radarr') throw new ArrApiError('File visibility checks require Radarr');
    const result = await this.request<{ type?: string }>(
      `/filesystem/type?path=${encodeURIComponent(path)}`,
    );
    if (
      !result || typeof result !== 'object' || Array.isArray(result) ||
      (result.type !== 'file' && result.type !== 'folder')
    ) throw new ArrApiError('Radarr returned an invalid file visibility response');
    return result.type;
  }

  async mediaFiles(mediaId: number): Promise<ArrManagedFile[] | null> {
    // A Sonarr series may contain tens of thousands of episodes, and this endpoint
    // does not offer a bounded file-list response. The managed series root remains
    // authoritative in the preview; avoid turning a confirmation dialog into a full
    // series export. Radarr movie file lists are naturally small.
    if (this.type !== 'radarr') return null;
    const records = await this.request<
      Array<{ relativePath?: string; path?: string; size?: number }>
    >(`/moviefile?movieId=${mediaId}`);
    return records.flatMap((record) => {
      const absolutePath = record.path?.trim();
      const relativePath = record.relativePath?.trim() ||
        absolutePath?.split(/[\\/]+/).filter(Boolean).at(-1);
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
      Array<{ id?: number; relativePath?: string; path?: string; size?: number }>
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
      absolutePath?.split(/[\\/]+/).filter(Boolean).at(-1);
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
    const matchingEpisodes = episodes.filter((candidate) =>
      candidate.seasonNumber === seasonNumber && candidate.episodeNumber === episodeNumber
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
    const shared = episodes.some((candidate) =>
      candidate.id !== episode.id && candidate.episodeFileId === episode.episodeFileId
    );
    const record = await this.request<{
      id?: number;
      relativePath?: string;
      path?: string;
      size?: number;
    }>(`/episodefile/${episode.episodeFileId}`);
    const absolutePath = record.path?.trim() || null;
    const relativePath = record.relativePath?.trim() ||
      absolutePath?.split(/[\\/]+/).filter(Boolean).at(-1);
    if (
      !Number.isInteger(record.id) || record.id !== episode.episodeFileId ||
      !relativePath
    ) {
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

  async deleteManagedFile(fileId: number): Promise<void> {
    const resource = this.type === 'radarr' ? 'moviefile' : 'episodefile';
    await this.request<void>(`/${resource}/${fileId}`, { method: 'DELETE' });
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
      Array<{ id?: number; seasonNumber?: number; episodeNumber?: number; monitored?: boolean }>
    >(
      `/episode?seriesId=${mediaId}&seasonNumber=${episode.seasonNumber}`,
    );
    const record = records.find((candidate) =>
      candidate.seasonNumber === episode.seasonNumber &&
      candidate.episodeNumber === episode.episodeNumber
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
      !Number.isSafeInteger(identity.episodeId) || identity.episodeId <= 0 ||
      !Number.isSafeInteger(identity.seriesId) || identity.seriesId <= 0 ||
      !Number.isSafeInteger(identity.seasonNumber) || identity.seasonNumber < 0 ||
      !Number.isSafeInteger(identity.episodeNumber) || identity.episodeNumber <= 0
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
      !record || typeof record !== 'object' || Array.isArray(record) ||
      record.id !== identity.episodeId || record.seriesId !== identity.seriesId ||
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
      !Number.isSafeInteger(identity.movieId) || identity.movieId <= 0 ||
      !Number.isSafeInteger(identity.tmdbId) || identity.tmdbId <= 0 ||
      typeof identity.path !== 'string' || identity.path.trim().length === 0 ||
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
      !record || typeof record !== 'object' || Array.isArray(record) ||
      record.id !== identity.movieId || record.tmdbId !== identity.tmdbId ||
      typeof record.path !== 'string' || record.path.trim() !== identity.path ||
      typeof record.monitored !== 'boolean'
    ) {
      throw new ArrApiError('Radarr returned a conflicting or malformed targeted movie');
    }
    return record as Record<string, unknown> & { id: number; monitored: boolean };
  }

  async radarrMovieMonitorTarget(
    identity: RadarrMovieMonitorIdentity,
  ): Promise<ArrMonitorTarget> {
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
      await this.request<void>(`/movie/${identity.movieId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...before, monitored }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      writeError = error;
    }
    let after: ArrMonitorTarget;
    try {
      after = await this.radarrMovieMonitorTarget(identity);
    } catch (error) {
      throw new ArrApiError(
        `Radarr movie monitoring read-back was inconclusive: ${
          error instanceof Error ? error.message : 'request failed'
        }`,
        undefined,
        true,
      );
    }
    if (after.monitored === monitored) return true;
    if (writeError) throw writeError;
    throw new ArrApiError('Radarr movie monitoring update did not converge');
  }

  async torrentAssociations(mediaId: number): Promise<ArrTorrentAssociation[]> {
    const path = this.type === 'radarr'
      ? `/history/movie?movieId=${mediaId}&includeMovie=false`
      : `/history/series?seriesId=${mediaId}&includeSeries=false&includeEpisode=false`;
    const records = await this.request<
      Array<{
        id?: number;
        date?: string;
        eventType?: string;
        downloadId?: string;
        data?: { droppedPath?: string; sourcePath?: string; importedPath?: string };
      }>
    >(path);
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
        !Array.isArray(response.records) || !Number.isInteger(response.totalRecords) ||
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
}
