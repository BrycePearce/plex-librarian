import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../../db/index.ts';
import {
  arrInstances,
  arrLibraryMappings,
  libraries,
  servers,
  servicePathRoots,
} from '../../db/schema.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import { ArrClient } from '../../integrations/arr/client.ts';
import { getDownloadClientTargets } from './targets.ts';
import { plexStorageDiscovery } from './plexStorageDiscovery.ts';
import type { ServicePathRoot, ServiceStorageEndpoint } from '../../../../shared/serviceStorage.ts';

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

export async function loadServiceRoots(serverId: number): Promise<ServicePathRoot[]> {
  const { refreshHostDiscovery, currentDiscoveryRoots } = await import(
    '../settings/hostDiscovery.ts'
  );
  await refreshHostDiscovery(serverId);
  const roots = await db.select().from(servicePathRoots).where(
    eq(servicePathRoots.serverId, serverId),
  )
    .orderBy(servicePathRoots.id);
  return currentDiscoveryRoots(serverId, roots);
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
  discover = false,
  reuseDiscovery: readonly ServiceStorageEndpoint[] = [],
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
  const plexDiscovery = discover
    ? await plexStorageDiscovery(active.client).catch(() => undefined)
    : undefined;
  async function add(
    endpoint: ServiceStorageEndpoint,
    read: (tested: () => void) => Promise<string[]>,
  ) {
    const reused = reuseDiscovery.find((entry) =>
      entry.key === endpoint.key && entry.configurationIdentity === endpoint.configurationIdentity
    );
    if (discover && reused) {
      endpoints.push({
        ...endpoint,
        roots: [...reused.roots],
        connectionTestedAt: reused.connectionTestedAt,
        discoveryError: reused.discoveryError,
      });
      return;
    }
    if (discover) {
      try {
        endpoint.roots = [
          ...new Set(
            await read(() => {
              endpoint.connectionTestedAt = Date.now();
            }),
          ),
        ].sort();
      } catch {
        endpoint.discoveryError =
          'Root discovery failed. Test the connection or enter its root manually.';
      }
    }
    endpoints.push(endpoint);
  }
  for (const library of libraryRows) {
    await add({
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
    }, (tested) => {
      if (!plexDiscovery) throw new Error('Plex connection test failed');
      tested();
      if (!plexDiscovery.read) throw new Error('Plex root discovery failed');
      return Promise.resolve(plexDiscovery.read(library.key).locations.map((root) => root.path));
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
    await add(endpoint, async (tested) => {
      const client = new ArrClient(arr.type, arr.url, arr.apiKey);
      await client.testConnection();
      tested();
      const roots = (await client.rootFolders()).map((root) => root.path);
      // Host-scoped suggestions only: never turn these into trusted relationships.
      endpoint.remotePathHints = await client.remotePathHints();
      for (const hint of endpoint.remotePathHints) roots.push(hint.localPath);
      // Current records include moved media outside the configured default roots.
      for (const scope of await client.managedScopes()) {
        if (!roots.some((root) => scope.path === root || scope.path.startsWith(`${root}/`))) {
          roots.push(scope.path);
        }
      }
      return roots;
    });
  }
  for (const target of qb) {
    await add({
      key: `qb:${target.instanceKey}`,
      name: target.instanceName,
      configurationIdentity: evidenceFingerprint(target.configurationIdentity),
      libraryKeys: libraryRows.map((library) => library.key),
      supportedMedia: true,
      ...connectionAddress(target.instanceUrl),
      roots: [],
    }, async (tested) => {
      if (!target.client.scanJobSummaries) throw new Error('Current job inventory is unavailable');
      if (!target.client.testConnection) throw new Error('Connection testing is unavailable');
      await target.client.testConnection();
      tested();
      const roots = new Set<string>(await target.client.storagePaths?.() ?? []);
      await target.client.scanJobSummaries((job) => {
        roots.add(job.savePath);
        if (roots.size > 1000) throw new Error('Too many current storage roots');
        return Promise.resolve();
      });
      return [...roots];
    });
  }
  return endpoints;
}

export function assertRootConfigurations(
  roots: readonly ServicePathRoot[],
  endpoints: readonly ServiceStorageEndpoint[],
) {
  for (const root of roots) {
    if (
      endpoints.find((endpoint) => endpoint.key === root.serviceKey)?.configurationIdentity !==
        root.configurationIdentity
    ) {
      throw new Error(
        `Storage relationship for ${root.serviceKey} needs confirmation after its connection changed. Review Media connections.`,
      );
    }
  }
}
