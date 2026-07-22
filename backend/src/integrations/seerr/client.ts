export class SeerrApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function normalizeSeerrUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL must not include credentials');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname
    .replace(/\/$/, '')
    .replace(/\/api\/v1$/i, '');
  return parsed.toString().replace(/\/$/, '');
}

export class SeerrClient {
  private readonly apiUrl: string;

  constructor(
    url: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.apiUrl = `${normalizeSeerrUrl(url)}/api/v1`;
  }

  private async request<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        headers: {
          Accept: 'application/json',
          'X-Api-Key': this.apiKey,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new SeerrApiError(
        `Seerr is unreachable: ${error instanceof Error ? error.message : 'request failed'}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new SeerrApiError(
        `Seerr returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        response.status,
      );
    }

    const text = await response.text();
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new SeerrApiError('Seerr returned an invalid JSON response');
    }
  }

  async testConnection(): Promise<{ version: string | null }> {
    const status = await this.request<{ version?: unknown }>('/status');
    // The status endpoint is public. Exercise the authenticated request endpoint too,
    // otherwise an invalid API key would be accepted during setup and fail only later.
    const requests = await this.request<{
      pageInfo?: unknown;
      results?: unknown;
    }>('/request?take=1&skip=0');
    if (!requests.pageInfo || !Array.isArray(requests.results)) {
      throw new SeerrApiError('Seerr returned an invalid requests response');
    }
    return {
      version: typeof status.version === 'string' ? status.version : null,
    };
  }

  async requestsPage(take: number, skip: number): Promise<SeerrRequestsPage> {
    const response = await this.request<SeerrRequestsPage>(
      `/request?take=${encodeURIComponent(take)}&skip=${encodeURIComponent(skip)}&sort=added`,
    );
    if (!response.pageInfo || !Array.isArray(response.results)) {
      throw new SeerrApiError('Seerr returned an invalid requests response');
    }
    return response;
  }
}

// Seerr/Overseerr/Jellyseerr status codes, shared so callers never re-guess the enum.
export const SEERR_REQUEST_STATUS_APPROVED = 2;
export const SEERR_MEDIA_STATUS_AVAILABLE = 5;

export interface SeerrRequestUser {
  email?: unknown;
  username?: unknown;
  plexUsername?: unknown;
}

export interface SeerrRequestMedia {
  tmdbId?: unknown;
  tvdbId?: unknown;
  mediaType?: unknown;
  status?: unknown;
  updatedAt?: unknown;
}

export interface SeerrRequestRecord {
  id?: unknown;
  status?: unknown;
  createdAt?: unknown;
  requestedBy?: SeerrRequestUser | null;
  media?: SeerrRequestMedia | null;
}

export interface SeerrRequestsPage {
  pageInfo: { pages?: unknown; results?: unknown };
  results: SeerrRequestRecord[];
}
