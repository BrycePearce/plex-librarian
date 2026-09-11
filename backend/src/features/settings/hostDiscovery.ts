import { eq } from 'drizzle-orm';
import { db, type SqliteClient, withTransaction } from '../../db/index.ts';
import { servicePathRoots } from '../../db/schema.ts';
import { evidenceFingerprint, serviceEndpoints } from '../mediaDeletion/serviceStorage.ts';
import type {
  HostDiscoveryStatus,
  ServicePathRoot,
  ServiceStorageEndpoint,
} from '../../../../shared/serviceStorage.ts';
import { dockerSemanticRevision, dockerStorage } from './dockerStorage.ts';
import { DISCOVERY_MAX_AGE_MS, readHostSnapshot } from './discoveryTransport.ts';
import { resolveDiscoveryAddresses } from './discoveryAddresses.ts';

// Host evidence is collected on each dependent read. Service inventories are reused
// for five minutes unless configuration or declared host layout changes.
export const SERVICE_DISCOVERY_INTERVAL_MS = 300_000;
export const DISCOVERY_BACKOFF_MS = [5_000, 30_000, 60_000] as const;
interface Pair {
  server_id: number;
  pairing_id: string;
  daemon_id: string;
  key_hash: string;
  generation: number;
  configuration: string | null;
  report_revision: string | null;
  scanned_at: number;
  checked_at: number;
  status: string;
  reason: string | null;
}
const running = new Map<number, Promise<void>>();
const failures = new Map<number, { count: number; next: number }>();
const serviceFailures = new Map<number, { count: number; next: number }>();
const rerun = new Set<number>();
const missingPathRefreshes = new Map<number, number>();
const unsupported = new Map<number, ServiceStorageEndpoint[]>();
const unavailable = new Map<number, ServiceStorageEndpoint[]>();
let readSnapshot = readHostSnapshot;
/** Local fixture seam; not exposed by routes or configuration. */
export function setHostDiscoveryReaderForTest(reader: typeof readHostSnapshot) {
  const previous = readSnapshot;
  readSnapshot = reader;
  failures.clear();
  serviceFailures.clear();
  missingPathRefreshes.clear();
  return () => {
    readSnapshot = previous;
    failures.clear();
    serviceFailures.clear();
    missingPathRefreshes.clear();
  };
}
function pair(client: SqliteClient, serverId: number) {
  return client.prepare('SELECT * FROM host_discovery WHERE server_id=?').get<Pair>(serverId);
}
export function discoveryConfiguration(client: SqliteClient, serverId: number) {
  return evidenceFingerprint([
    client.prepare('SELECT active_server_id FROM settings WHERE id=1').all(),
    client.prepare('SELECT * FROM servers WHERE id=?').all(serverId),
    client.prepare('SELECT key,type FROM libraries WHERE server_id=? ORDER BY key').all(serverId),
    ...['arr_instances', 'qbittorrent_instances', 'arr_library_mappings', 'service_path_roots'].map(
      (table) =>
        client.prepare(`SELECT * FROM ${table} WHERE server_id=? ORDER BY rowid`).all(serverId),
    ),
    ['PLEX_URL', 'PLEX_TOKEN', 'QBITTORRENT_URL', 'QBITTORRENT_USERNAME', 'QBITTORRENT_PASSWORD']
      .map((key) => Deno.env.get(key)),
  ]);
}
function active(client: SqliteClient, serverId: number) {
  return client.prepare('SELECT active_server_id FROM settings WHERE id=1').value<[number]>()
    ?.[0] === serverId;
}

export async function enableHostDiscovery(serverId: number) {
  const before = withTransaction((c) => discoveryConfiguration(c, serverId));
  const snapshot = await readSnapshot();
  withTransaction((c) => {
    if (!active(c, serverId) || before !== discoveryConfiguration(c, serverId)) {
      throw new Error('Connections changed; enable discovery again');
    }
    const existing = pair(c, serverId);
    if (
      existing &&
      (existing.daemon_id !== snapshot.report.daemonId || existing.key_hash !== snapshot.keyHash)
    ) {
      throw new Error(
        'Paired host changed. Disable discovery in Advanced before pairing a replacement.',
      );
    }
    c.prepare(
      'INSERT INTO host_discovery(server_id,pairing_id,daemon_id,key_hash) VALUES (?,?,?,?) ON CONFLICT(server_id) DO NOTHING',
    )
      .run(serverId, crypto.randomUUID(), snapshot.report.daemonId, snapshot.keyHash);
  });
  triggerHostDiscovery(serverId);
}
export function disableHostDiscovery(serverId: number) {
  missingPathRefreshes.delete(serverId);
  withTransaction((c) => {
    // Keep root provenance and accepted operation evidence. Unpaired roots cannot
    // become manual authority just because the helper has been disabled.
    c.prepare('DELETE FROM host_discovery WHERE server_id=?').run(serverId);
    c.prepare(
      'UPDATE host_discovery_roots SET checked_at=0 WHERE root_id IN (SELECT id FROM service_path_roots WHERE server_id=?)',
    ).run(serverId);
  });
  failures.delete(serverId);
  serviceFailures.delete(serverId);
  unsupported.delete(serverId);
  unavailable.delete(serverId);
}
export function triggerHostDiscovery(serverId: number) {
  missingPathRefreshes.delete(serverId);
  unsupported.delete(serverId);
  unavailable.delete(serverId);
  const exists = withTransaction((c) => {
    if (!pair(c, serverId)) return false;
    c.prepare(
      'UPDATE host_discovery SET generation=generation+1,scanned_at=0,checked_at=0 WHERE server_id=?',
    ).run(serverId);
    return true;
  });
  if (!exists) return;
  failures.delete(serverId);
  serviceFailures.delete(serverId);
  if (running.has(serverId)) {
    rerun.add(serverId);
    return;
  }
  void refreshHostDiscovery(serverId);
}

/** One coordinator; no deletion queue or changes to accepted target snapshots. */
export function refreshHostDiscovery(serverId: number): Promise<void> {
  const pending = running.get(serverId);
  if (pending) return pending;
  const task = refresh(serverId).finally(() => {
    running.delete(serverId);
    if (rerun.delete(serverId)) void refreshHostDiscovery(serverId);
  });
  running.set(serverId, task);
  return task;
}

/** A live QB inventory can introduce a save path without a connection or mount edit.
 * Reuse the normal publication checks, with one extra scan per interval across all
 * preview choices/items. This never resets failed-service or failed-host budgets. */
export async function refreshMissingDownloadRoot(serverId: number, serviceKey: string) {
  if (!serviceKey.startsWith('qb:')) return false;
  await running.get(serverId);
  const now = Date.now();
  if (
    failures.has(serverId) || serviceFailures.has(serverId) ||
    now - (missingPathRefreshes.get(serverId) ?? -Infinity) < SERVICE_DISCOVERY_INTERVAL_MS
  ) return false;
  const eligible = withTransaction((c) => {
    const paired = pair(c, serverId);
    if (!paired || !active(c, serverId) || !paired.checked_at) return false;
    const status = JSON.parse(paired.status) as HostDiscoveryStatus['services'];
    if (!status.some((s) => s.serviceKey === serviceKey && s.state === 'ready')) return false;
    const manual = c.prepare(
      'SELECT r.id FROM service_path_roots r LEFT JOIN host_discovery_roots h ON h.root_id=r.id WHERE r.server_id=? AND r.service_key=? AND h.root_id IS NULL LIMIT 1',
    ).get(serverId, serviceKey);
    if (manual) return false;
    c.prepare('UPDATE host_discovery SET scanned_at=0,generation=generation+1 WHERE server_id=?')
      .run(serverId);
    return true;
  });
  if (!eligible) return false;
  missingPathRefreshes.set(serverId, now);
  await refreshHostDiscovery(serverId);
  return true;
}
async function refresh(serverId: number) {
  const initial = withTransaction((c) => ({
    pair: pair(c, serverId),
    configuration: discoveryConfiguration(c, serverId),
    active: active(c, serverId),
  }));
  const paired = initial.pair;
  if (!paired || !initial.active) return;
  const hostFailure = failures.get(serverId);
  const failure = serviceFailures.get(serverId);
  if (hostFailure && hostFailure.next > Date.now()) return;
  withTransaction((c) =>
    c.prepare('UPDATE host_discovery SET checked_at=0 WHERE server_id=?').run(serverId)
  );
  const stillCurrent = (c: SqliteClient) =>
    active(c, serverId) && pair(c, serverId)?.pairing_id === paired.pairing_id &&
    pair(c, serverId)?.generation === paired.generation &&
    discoveryConfiguration(c, serverId) === initial.configuration;
  try {
    const { report, keyHash } = await readSnapshot();
    if (report.daemonId !== paired.daemon_id || keyHash !== paired.key_hash) {
      throw new Error('Host identity changed');
    }
    const configuredEndpoints = await serviceEndpoints(serverId);
    const addresses = await resolveDiscoveryAddresses(
      configuredEndpoints,
      report.containers.flatMap((c) => c.Networks.flatMap((n) => n.Aliases)),
    );
    const revision = dockerSemanticRevision({ report, addresses });
    const now = Math.floor(Date.now() / 1000);
    if (
      !(failure && failure.next <= Date.now()) &&
      paired.configuration === initial.configuration &&
      paired.report_revision === revision &&
      (now - paired.scanned_at) * 1000 < SERVICE_DISCOVERY_INTERVAL_MS
    ) {
      const published = withTransaction((c) => {
        if (!stillCurrent(c)) return false;
        c.prepare('UPDATE host_discovery SET checked_at=?,reason=NULL WHERE server_id=?').run(
          now,
          serverId,
        );
        c.prepare(
          'UPDATE host_discovery_roots SET checked_at=? WHERE checked_at>0 AND root_id IN (SELECT id FROM service_path_roots WHERE server_id=?)',
        ).run(now, serverId);
        return true;
      });
      if (published) failures.delete(serverId);
      return;
    }
    const sameLayout = paired.configuration === initial.configuration &&
      paired.report_revision === revision;
    const endpoints = await serviceEndpoints(
      serverId,
      true,
      sameLayout
        ? [
          ...unsupported.get(serverId) ?? [],
          ...(failure && failure.next > Date.now() ? unavailable.get(serverId) ?? [] : []),
        ]
        : [],
    );
    const roots = await db.select().from(servicePathRoots).where(
      eq(servicePathRoots.serverId, serverId),
    );
    const result = dockerStorage(
      JSON.stringify(report),
      endpoints,
      roots,
      Date.now(),
      {},
      true,
      addresses,
    );
    const statuses: HostDiscoveryStatus['services'] = result.preview.services.map((s) => ({
      serviceKey: s.serviceKey,
      name: s.name,
      connected: !!endpoints.find((e) => e.key === s.serviceKey)?.connectionTestedAt,
      state: s.reason ? 'needs_attention' : 'ready',
      reason: s.reason,
    }));
    const published = withTransaction((c) => {
      if (!stillCurrent(c)) return false;
      c.prepare(
        'UPDATE host_discovery_roots SET checked_at=0 WHERE root_id IN (SELECT id FROM service_path_roots WHERE server_id=?)',
      ).run(serverId);
      for (const status of statuses) {
        const proposed = result.relationships.filter((r) => r.serviceKey === status.serviceKey);
        const existing = roots.filter((r) => r.serviceKey === status.serviceKey);
        const manual = existing.some((r) =>
          !c.prepare('SELECT root_id FROM host_discovery_roots WHERE root_id=?').get(r.id)
        );
        if (manual) {
          status.state = 'needs_attention';
          status.reason = 'Manual relationships preserved. Review this service in Advanced.';
          continue;
        }
        const identity = result.preview.services.find((s) => s.serviceKey === status.serviceKey)
          ?.evidenceIdentity;
        if (status.state !== 'ready' || !proposed.length || !identity) {
          status.state = 'needs_attention';
          status.reason ??= result.preview.reason ?? 'Discovery evidence unavailable';
          continue;
        }
        for (
          const old of existing.filter((r) =>
            !proposed.some((p) => p.serviceRoot === r.serviceRoot)
          )
        ) {
          c.prepare('DELETE FROM service_path_roots WHERE id=?').run(old.id);
        }
        for (const root of proposed) {
          const old = existing.find((r) => r.serviceRoot === root.serviceRoot);
          const previousIdentity = old &&
            c.prepare('SELECT evidence_identity FROM host_discovery_roots WHERE root_id=?').value<
              [string]
            >(old.id)?.[0];
          const unchanged = old && old.configurationIdentity === root.configurationIdentity &&
            old.storageRoot === root.storageRoot && old.caseSensitive === root.caseSensitive &&
            old.hasAliases === root.hasAliases && previousIdentity === identity;
          let id = old?.id;
          if (old && !unchanged) {
            c.prepare(
              'UPDATE service_path_roots SET configuration_identity=?,storage_root=?,case_sensitive=?,has_aliases=?,revision=revision+1 WHERE id=?',
            ).run(
              root.configurationIdentity,
              root.storageRoot,
              Number(root.caseSensitive),
              Number(root.hasAliases),
              old.id,
            );
          }
          if (!old) {
            id = c.prepare(
              'INSERT INTO service_path_roots(server_id,service_key,configuration_identity,service_root,storage_root,case_sensitive,has_aliases) VALUES (?,?,?,?,?,?,?) RETURNING id',
            ).value<[number]>(
              serverId,
              root.serviceKey,
              root.configurationIdentity,
              root.serviceRoot,
              root.storageRoot,
              Number(root.caseSensitive),
              Number(root.hasAliases),
            )![0];
          }
          c.prepare(
            'INSERT INTO host_discovery_roots(root_id,evidence_identity,checked_at) VALUES (?,?,?) ON CONFLICT(root_id) DO UPDATE SET evidence_identity=excluded.evidence_identity,checked_at=excluded.checked_at',
          ).run(id!, identity, now);
        }
      }
      c.prepare(
        'UPDATE host_discovery SET configuration=?,report_revision=?,scanned_at=?,checked_at=?,status=?,reason=NULL WHERE server_id=?',
      ).run(
        discoveryConfiguration(c, serverId),
        revision,
        now,
        now,
        JSON.stringify(statuses),
        serverId,
      );
      unsupported.set(
        serverId,
        endpoints.filter((endpoint) =>
          endpoint.connectionTestedAt && !endpoint.discoveryError &&
          result.preview.services.some((s) => s.serviceKey === endpoint.key && s.reason)
        ),
      );
      unavailable.set(serverId, endpoints.filter((endpoint) => !!endpoint.discoveryError));
      return true;
    });
    if (!published) return;
    failures.delete(serverId);
    if (
      endpoints.some((endpoint) => endpoint.supportedMedia !== false && endpoint.discoveryError)
    ) {
      if (sameLayout && failure && failure.next > Date.now()) return;
      const count = (failure?.count ?? 0) + 1;
      serviceFailures.set(serverId, {
        count,
        next: count <= DISCOVERY_BACKOFF_MS.length
          ? Date.now() + DISCOVERY_BACKOFF_MS[count - 1]
          : Infinity,
      });
    } else serviceFailures.delete(serverId);
  } catch {
    if (!withTransaction(stillCurrent)) return;
    const count = (hostFailure?.count ?? 0) + 1;
    failures.set(serverId, {
      count,
      next: count <= DISCOVERY_BACKOFF_MS.length
        ? Date.now() + DISCOVERY_BACKOFF_MS[count - 1]
        : Infinity,
    });
    withTransaction((c) => {
      if (!stillCurrent(c)) return;
      c.prepare('UPDATE host_discovery SET checked_at=0,reason=? WHERE server_id=?').run(
        'Host discovery unavailable. Check the helper and Retry; service connections remain saved.',
        serverId,
      );
    });
  }
}

export function currentDiscoveryRoots(
  serverId: number,
  roots: ServicePathRoot[],
): ServicePathRoot[] {
  return withTransaction((c) => {
    const paired = pair(c, serverId);
    return roots.map((root) => {
      const proof = c.prepare('SELECT checked_at FROM host_discovery_roots WHERE root_id=?').value<
        [number]
      >(root.id);
      if (!proof) return root;
      const now = Math.floor(Date.now() / 1000);
      const valid = paired && active(c, serverId) && paired.checked_at > 0 && proof[0] > 0 &&
        now >= proof[0] && (now - proof[0]) * 1000 <= DISCOVERY_MAX_AGE_MS &&
        (now - paired.checked_at) * 1000 <= DISCOVERY_MAX_AGE_MS;
      return valid
        ? root
        : { ...root, configurationIdentity: `discovery-unavailable:${root.configurationIdentity}` };
    });
  });
}
export function hostDiscoveryStatus(serverId: number): HostDiscoveryStatus {
  return withTransaction((c) => {
    const row = pair(c, serverId);
    const stale = !row?.checked_at || Date.now() - row.checked_at * 1000 > DISCOVERY_MAX_AGE_MS;
    const services = JSON.parse(row?.status ?? '[]') as HostDiscoveryStatus['services'];
    return {
      enabled: !!row,
      checking: running.has(serverId),
      reason: row?.reason ?? undefined,
      services: services.map((s) =>
        stale
          ? {
            ...s,
            state: 'needs_attention',
            reason: row?.reason ?? 'Discovery evidence needs refresh',
          }
          : s
      ),
    };
  });
}
export function startHostDiscovery() {
  let nextPoll = 0;
  const tick = () => {
    const id = withTransaction((c) =>
      c.prepare(
        'SELECT h.server_id FROM host_discovery h JOIN settings s ON s.active_server_id=h.server_id WHERE s.id=1',
      ).value<[number]>()?.[0]
    );
    if (
      id !== undefined &&
      (Date.now() >= nextPoll || (failures.get(id)?.next ?? Infinity) <= Date.now() ||
        !failures.has(id) && (serviceFailures.get(id)?.next ?? Infinity) <= Date.now())
    ) {
      nextPoll = Date.now() + 30_000;
      void refreshHostDiscovery(id);
    }
  };
  tick();
  const timer = setInterval(tick, 5_000);
  Deno.unrefTimer(timer);
}
