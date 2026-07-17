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
}

export interface ArrManagedFile {
  relativePath: string;
  size: number | null;
}

export class ArrApiError extends Error {
  constructor(message: string, readonly status?: number) {
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
    const record = records[0];
    return record
      ? {
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
      }
      : null;
  }

  async extraFiles(mediaId: number): Promise<ArrExtraFile[]> {
    if (this.type !== 'radarr') return [];
    const records = await this.request<
      Array<{ relativePath?: string; type?: number | string }>
    >(`/extrafile?movieId=${mediaId}`);
    return records.flatMap((record) => {
      const relativePath = record.relativePath?.trim();
      if (!relativePath) return [];
      const rawType = String(record.type ?? '').toLowerCase();
      const type = rawType === '0' || rawType === 'subtitle'
        ? 'subtitle'
        : rawType === '1' || rawType === 'metadata'
        ? 'metadata'
        : 'other';
      return [{ relativePath, type } satisfies ArrExtraFile];
    });
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
