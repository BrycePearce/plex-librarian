import type { PlexItem, PlexLibrary } from '../types/plex.ts';

export type { PlexItem, PlexLibrary };

interface PlexRawSection {
  key: string;
  title: string;
  type: string;
}

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
    const data = await this.get<{ MediaContainer: { Directory?: PlexRawSection[] } }>(
      '/library/sections',
    );
    return (data.MediaContainer.Directory ?? []).map(({ key, title, type }) => ({
      key,
      title,
      type,
    }));
  }

  async hasPlexPass(): Promise<boolean> {
    const data = await this.get<{ MediaContainer: { myPlexSubscription?: number } }>('/');
    return !!data.MediaContainer.myPlexSubscription;
  }

  async libraryItems(libraryKey: string): Promise<PlexItem[]> {
    const all: PlexRawMetadata[] = [];
    let start = 0;

    while (true) {
      const data = await this.get<{
        MediaContainer: { Metadata?: PlexRawMetadata[]; totalSize?: number };
      }>(
        `/library/sections/${libraryKey}/all`,
        {
          'X-Plex-Container-Start': String(start),
          'X-Plex-Container-Size': String(ITEMS_PAGE_SIZE),
        },
      );
      const page = data.MediaContainer.Metadata ?? [];
      all.push(...page);
      if (page.length < ITEMS_PAGE_SIZE) break;
      const total = data.MediaContainer.totalSize;
      if (total !== undefined && all.length >= total) break;
      start += ITEMS_PAGE_SIZE;
    }

    return all.map((item) => {
      const sizeSum = item.Media
        ?.flatMap((m) => m.Part ?? [])
        .reduce((acc, p) => acc + (p.size ?? 0), 0);
      return {
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        addedAt: item.addedAt ?? null,
        lastViewedAt: item.lastViewedAt ?? null,
        viewCount: item.viewCount ?? 0,
        fileSize: sizeSum ?? null,
        duration: item.duration ?? null,
        year: item.year ?? null,
      };
    });
  }
}

export class PlexConfigError extends Error {
  constructor() {
    super('PLEX_URL must be set');
    this.name = 'PlexConfigError';
  }
}

export function createPlexClient(): PlexClient {
  const url = Deno.env.get('PLEX_URL');
  if (!url) throw new PlexConfigError();
  return new PlexClient(url, Deno.env.get('PLEX_TOKEN') ?? '');
}
