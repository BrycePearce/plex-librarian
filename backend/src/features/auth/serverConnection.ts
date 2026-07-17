import { buildPlexHeaders } from '../../integrations/plex/headers.ts';

export class PlexConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlexConnectionError';
  }
}

function normalizeServerUrls(values: unknown[]): string[] {
  const urls: string[] = [];
  for (const value of values.slice(0, 20)) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const normalized = url.toString().replace(/\/$/, '');
      if (!urls.includes(normalized)) urls.push(normalized);
    } catch {
      // Plex can return stale or malformed connection entries. Ignore them and try
      // the remaining advertised addresses rather than making setup fail outright.
    }
  }
  return urls;
}

/**
 * Selects the first advertised Plex address that is reachable from the backend and
 * identifies itself as the server the user selected. Candidates are already ordered
 * local -> direct remote -> relay by the PIN route, so preserving that order prefers
 * the fastest working connection without asking the user to understand Docker routing.
 */
export async function selectReachablePlexUrl(
  candidateValues: unknown[],
  accessToken: string,
  clientId: string,
  expectedMachineIdentifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const candidates = normalizeServerUrls(candidateValues);
  if (candidates.length === 0) {
    throw new PlexConnectionError('Plex did not report any usable addresses for this server.');
  }

  // Probe together so a dead local address does not add a full timeout before a working
  // direct or relay address is tried. Promise.all preserves input order, which lets us
  // still choose the highest-ranked successful candidate.
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const response = await fetchImpl(`${candidate}/identity`, {
          headers: buildPlexHeaders(clientId, accessToken),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          response.body?.cancel();
          return null;
        }
        const body = (await response.json()) as {
          MediaContainer?: { machineIdentifier?: string };
        };
        return body.MediaContainer?.machineIdentifier === expectedMachineIdentifier
          ? candidate
          : null;
      } catch {
        return null;
      }
    }),
  );

  const selected = results.find((result): result is string => result !== null);
  if (selected) return selected;

  throw new PlexConnectionError(
    "Plex Librarian couldn't reach this server from its container. Make sure the server is online and allows remote connections, then try again.",
  );
}
