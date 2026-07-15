import type { ArrType } from '@plex-librarian/shared/types.ts';

export interface ArrMediaRecord {
  id: number;
  title: string;
}

export interface ArrTorrentAssociation {
  hash: string;
  sourcePath: string | null;
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
    const records = await this.request<Array<{ id: number; title?: string }>>(path);
    const record = records[0];
    return record ? { id: record.id, title: record.title ?? String(record.id) } : null;
  }

  async torrentAssociations(mediaId: number): Promise<ArrTorrentAssociation[]> {
    const path = this.type === 'radarr'
      ? `/history/movie?movieId=${mediaId}&includeMovie=false`
      : `/history/series?seriesId=${mediaId}&includeSeries=false&includeEpisode=false`;
    const records = await this.request<
      Array<{
        eventType?: string;
        downloadId?: string;
        data?: { droppedPath?: string; sourcePath?: string };
      }>
    >(path);
    const associations = new Map<string, ArrTorrentAssociation>();
    for (const record of records) {
      if (record.eventType?.toLowerCase() !== 'downloadfolderimported') continue;
      const hash = record.downloadId?.trim().toLowerCase();
      // BitTorrent v1 hashes are 40 hex characters; v2 hashes are 64. Anything else
      // may be a Usenet download ID and must never be sent to qBittorrent.
      if (!hash || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) continue;
      associations.set(hash, {
        hash,
        sourcePath: record.data?.droppedPath ?? record.data?.sourcePath ?? null,
      });
    }
    return [...associations.values()];
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
