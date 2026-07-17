// Account-level Plex API root — distinct from a Plex Media Server's own URL.
export const PLEX_TV = 'https://plex.tv';

export const PLEX_CLIENT_PRODUCT = 'Plex Librarian';
const PLEX_CLIENT_VERSION = '1.0.0';
const PLEX_CLIENT_PLATFORM = 'Web';

export function buildPlexHeaders(clientId?: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Plex-Product': PLEX_CLIENT_PRODUCT,
    'X-Plex-Version': PLEX_CLIENT_VERSION,
    'X-Plex-Platform': PLEX_CLIENT_PLATFORM,
  };
  if (clientId) headers['X-Plex-Client-Identifier'] = clientId;
  if (token) headers['X-Plex-Token'] = token;
  return headers;
}
