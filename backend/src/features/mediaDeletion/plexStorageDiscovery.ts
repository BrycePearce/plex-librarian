import type { PlexClient } from '../../integrations/plex/client.ts';

/** Reuse connection and section evidence only within this discovery request. */
export async function plexStorageDiscovery(
  client: Pick<PlexClient, 'identity' | 'libraryLocationReader'>,
) {
  const identity = await client.identity();
  if (typeof identity !== 'string' || !identity.trim()) {
    throw new Error('Plex did not return a server identity');
  }
  const connectionTestedAt = Date.now();
  try {
    return { connectionTestedAt, read: await client.libraryLocationReader() };
  } catch {
    // Successful connection testing is independent of complete root discovery.
    return { connectionTestedAt, read: undefined };
  }
}
