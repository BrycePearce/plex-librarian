import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../../db/index.ts';
import { arrInstances, arrLibraryMappings, libraries, servers } from '../../db/schema.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import { getDownloadClientTargets } from './targets.ts';
import type { ServiceStorageEndpoint } from '../../../../shared/serviceStorage.ts';

export function evidenceFingerprint(value: unknown): string {
  function canonical(entry: unknown): unknown {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map((
          [key, value],
        ) => [key, canonical(value)]),
      );
    }
    return entry;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function connectionAddress(value: string | undefined): Partial<ServiceStorageEndpoint> {
  if (!value) return {};
  const url = new URL(value);
  return {
    connectionHost: url.hostname,
    connectionPort: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    connectionPath: url.pathname,
  };
}

/** Configuration identity is non-secret and changes with the configured endpoint/credential. */
export async function serviceEndpoints(
  serverId: number,
): Promise<ServiceStorageEndpoint[]> {
  const active = await resolveActiveServer();
  if (active.serverId !== serverId) throw new Error('The active server changed');
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
  const libraryRows = await db.select().from(libraries).where(eq(libraries.serverId, serverId));
  const arrRows = await db.select().from(arrInstances).where(eq(arrInstances.serverId, serverId));
  const mappings = await db.select().from(arrLibraryMappings).where(
    eq(arrLibraryMappings.serverId, serverId),
  );
  const qb = await getDownloadClientTargets(serverId);
  const endpoints: ServiceStorageEndpoint[] = [];
  for (const library of libraryRows) {
    endpoints.push({
      key: `plex:${library.key}`,
      name: `Plex · ${library.title}`,
      libraryKeys: [library.key],
      supportedMedia: library.type === 'movie' || library.type === 'show',
      ...connectionAddress(active.client.serverUrl),
      roots: [],
      configurationIdentity: evidenceFingerprint([
        serverId,
        active.client.serverUrl,
        server?.machineIdentifier,
        Deno.env.get('PLEX_TOKEN') || server?.accessToken,
      ]),
    });
  }
  for (const arr of arrRows) {
    const endpoint: ServiceStorageEndpoint = {
      key: `arr:${arr.id}`,
      name: arr.name,
      libraryKeys: mappings.filter((mapping) => mapping.arrInstanceId === arr.id).map((mapping) =>
        mapping.libraryKey
      ),
      roots: [],
      configurationIdentity: evidenceFingerprint([arr.id, arr.url, arr.apiKey, arr.updatedAt]),
      ...connectionAddress(arr.url),
      supportedMedia: mappings.some((mapping) =>
        mapping.arrInstanceId === arr.id &&
        libraryRows.some((library) =>
          library.key === mapping.libraryKey &&
          (library.type === 'movie' || library.type === 'show')
        )
      ),
    };
    endpoints.push(endpoint);
  }
  for (const target of qb) {
    endpoints.push({
      key: `qb:${target.instanceKey}`,
      name: target.instanceName,
      configurationIdentity: evidenceFingerprint(target.configurationIdentity),
      libraryKeys: libraryRows.map((library) => library.key),
      supportedMedia: true,
      ...connectionAddress(target.instanceUrl),
      roots: [],
    });
  }
  return endpoints;
}
