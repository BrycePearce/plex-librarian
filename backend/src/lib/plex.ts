import type { PlexItem, PlexLibrary } from '../types/plex.ts';

export type { PlexItem, PlexLibrary };

interface PlexRawMetadata {
  ratingKey: string;
  title: string;
  type: string;
  addedAt?: number;
  lastViewedAt?: number;
  viewCount?: number;
  duration?: number;
  year?: number;
  Media?: Array<{ Part?: Array<{ size?: number }> }>;
}

const ITEMS_PAGE_SIZE = 300;
const FETCH_CONCURRENCY = 8;

function mapItems(raw: PlexRawMetadata[]): PlexItem[] {
  return raw.map((item) => {
    const parts = item.Media?.flatMap((m) => m.Part ?? []).filter((p) => p.size != null) ?? [];
    const fileSize = parts.length > 0 ? parts.reduce((acc, p) => acc + p.size!, 0) : null;
    return {
      ratingKey: item.ratingKey,
      title: item.title,
      type: item.type,
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

  constructor(url: string, private readonly token: string) {
    this.url = url.replace(/\/$/, '');
  }

  private async get<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
    const headers: Record<string, string> = { ...extraHeaders, Accept: 'application/json' };
    if (this.token) headers['X-Plex-Token'] = this.token;
    const res = await fetch(`${this.url}${path}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Plex ${res.status}: ${path}`);
    return await res.json() as T;
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

  async *libraryItems(libraryKey: string): AsyncGenerator<PlexItem[]> {
    const fetchPage = (start: number) =>
      this.get<{ MediaContainer: { Metadata?: PlexRawMetadata[]; totalSize?: number } }>(
        `/library/sections/${libraryKey}/all`,
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

export function createPlexClient(): PlexClient {
  const url = Deno.env.get('PLEX_URL');
  if (!url) throw new PlexConfigError('PLEX_URL must be set');
  const token = Deno.env.get('PLEX_TOKEN');
  if (!token) throw new PlexConfigError('PLEX_TOKEN must be set');
  return new PlexClient(url, token);
}
