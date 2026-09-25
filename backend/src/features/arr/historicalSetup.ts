import { withTransaction } from '../../db/index.ts';
import { ArrClient } from '../../integrations/arr/client.ts';
import type { ArrPathMapping } from '../../../../shared/types.ts';
import { serviceOwnedFingerprint } from '../mediaDeletion/serviceOwnedPlanning.ts';
import { historicalDownloadFolders } from './historicalDownloadFolders.ts';
import { listHistoricalAccess } from './historicalDownloadAccess.ts';
import { probeHistoricalSetup } from './historicalSetupProbe.ts';
import { boundedHistoricalInspection } from './historicalAccessInspection.ts';

function context(serverId: number, instanceId: number) {
  return withTransaction((db) => {
    const row = db.prepare('SELECT type,url,api_key FROM arr_instances WHERE server_id=? AND id=?')
      .value<['sonarr' | 'radarr', string, string]>(serverId, instanceId);
    if (!row) return null;
    const mappings = db.prepare(
      'SELECT kind,arr_path,local_path FROM arr_path_mappings WHERE arr_instance_id=? ORDER BY id',
    )
      .values<[ArrPathMapping['kind'], string, string]>(instanceId)
      .map(([kind, arrPath, localPath]) => ({ kind, arrPath, localPath }));
    return {
      row,
      mappings,
      revision: serviceOwnedFingerprint([row, mappings]),
    };
  });
}

/** Read a bounded window using the existing server/library indexes, rather than
 * sorting an entire catalog just to find a setup witness. Prefer recent titles
 * within that window; a miss still leaves manual setup available. */
function sampleTitles(serverId: number, instanceId: number, type: 'radarr' | 'sonarr') {
  return withTransaction((db) => {
    const libraries = db.prepare(
      'SELECT library_key FROM arr_library_mappings WHERE server_id=? AND arr_instance_id=? ORDER BY library_key LIMIT 4',
    ).values<[string]>(serverId, instanceId);
    const candidates = libraries.flatMap(([library]) =>
      db.prepare(
        'SELECT tmdb_id,tvdb_id,added_at FROM items WHERE server_id=? AND library_key=? LIMIT 64',
      ).values<[number | null, number | null, number | null]>(serverId, library)
    );
    candidates.sort((a, b) => (b[2] ?? 0) - (a[2] ?? 0));
    const ids = [
      ...new Set(
        candidates.map((row) => row[type === 'radarr' ? 0 : 1])
          .filter((id): id is number => id !== null),
      ),
    ].slice(0, 4);
    return { ids, hasItems: candidates.length > 0 };
  });
}

async function probe(serverId: number, instanceId: number) {
  const before = context(serverId, instanceId);
  if (!before) return null;
  const samples = sampleTitles(serverId, instanceId, before.row[0]);
  if (!samples.ids.length) {
    if (samples.hasItems) return null;
    return { waitingForSync: true as const, connectionRevision: before.revision };
  }
  const client = new ArrClient(...before.row);
  const deadline = Date.now() + 25_000;
  const mounts = await historicalDownloadFolders();
  const proposal = await probeHistoricalTitles(samples.ids, async (id) => {
    if (Date.now() >= deadline) return null;
    const title = await client.lookup(id);
    if (!title || Date.now() >= deadline) return null;
    const history = await client.historicalImports(title.id);
    if (history.problems.length || Date.now() >= deadline) return null;
    return await probeHistoricalSetup(history.records, before.mappings, mounts);
  }, Math.max(0, deadline - Date.now()));
  if (!proposal || context(serverId, instanceId)?.revision !== before.revision) return null;
  return { ...proposal, connectionRevision: before.revision };
}

/** Sequential, bounded fallback: a missing first title/download is not decisive.
 * The same deadline covers service reads and filesystem probes across all titles. */
export async function probeHistoricalTitles<T>(
  ids: readonly number[],
  inspect: (id: number) => Promise<T | null>,
  timeoutMs = 25_000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (const id of ids.slice(0, 4)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    try {
      const result = await boundedHistoricalInspection(inspect(id), remaining);
      if (result) return result;
    } catch { /* Try another bounded sample; no access is granted on failure. */ }
  }
  return null;
}

const pending = new Map<string, Promise<void>>();
const pendingSignals = new Map<string, string>();
function discoverySignal(serverId: number, instanceId: number) {
  return serviceOwnedFingerprint([
    context(serverId, instanceId)?.revision,
    listHistoricalAccess(serverId).filter((s) => s.instanceId === instanceId),
    withTransaction((db) =>
      db.prepare(
        'SELECT library_key FROM arr_library_mappings WHERE server_id=? AND arr_instance_id=? ORDER BY library_key',
      ).values<[string]>(serverId, instanceId)
    ),
  ]);
}
/** Trigger only on successful connection/configuration writes or explicit retry.
 * No startup, GET, polling or background retry trigger. */
export async function discoverHistoricalSetup(
  serverId: number,
  instanceId: number,
  inspect = probe,
): Promise<void> {
  const key = `${serverId}:${instanceId}`;
  if (pending.has(key)) {
    if (pendingSignals.get(key) === discoverySignal(serverId, instanceId)) return pending.get(key)!;
    // A new explicit write superseded the in-flight probe. Wait for its bounded
    // result, then inspect the newest configuration once; unchanged calls coalesce.
    await pending.get(key)!;
    return await discoverHistoricalSetup(serverId, instanceId, inspect);
  }
  if (pending.size >= 4) return Promise.resolve();
  const statuses = listHistoricalAccess(serverId).filter((s) => s.instanceId === instanceId);
  const automaticIds = new Set(
    withTransaction((db) =>
      db.prepare(
        'SELECT id,reason FROM historical_download_access WHERE server_id=? AND arr_instance_id=?',
      ).values<[string, string | null]>(serverId, instanceId)
    ).filter(([, reason]) => {
      try {
        return typeof JSON.parse(reason ?? '{}').setupConnectionRevision === 'string';
      } catch {
        return false;
      }
    }).map(([id]) => id),
  );
  // Never rewrite a user's saved setup, including intentionally disabled folders.
  if (
    statuses.some((s) =>
      s.status === 'draft' ||
      s.configuration.enabled ||
      (s.configuration.localRoot && s.status !== 'ready_to_enable' && !automaticIds.has(s.id))
    )
  ) {
    return Promise.resolve();
  }
  // Withdraw a previous offer immediately when connection settings change.
  for (const status of statuses.filter((s) => s.status === 'ready_to_enable')) {
    withTransaction((db) =>
      db.prepare(
        "UPDATE historical_download_access SET status='not_enabled' WHERE id=? AND revision=?",
      )
        .run(status.id, status.revision)
    );
  }
  const snapshot = serviceOwnedFingerprint(
    listHistoricalAccess(serverId).filter((s) => s.instanceId === instanceId),
  );
  pendingSignals.set(key, discoverySignal(serverId, instanceId));
  const work = (async () => {
    const proposal = await boundedHistoricalInspection(inspect(serverId, instanceId), 25_000);
    if (
      serviceOwnedFingerprint(
        listHistoricalAccess(serverId).filter((s) => s.instanceId === instanceId),
      ) !== snapshot
    ) return;
    if (!proposal || context(serverId, instanceId)?.revision !== proposal.connectionRevision) {
      return;
    }
    if (!statuses.length && listHistoricalAccess(serverId).length >= 20) return;
    withTransaction((db) => {
      // Replace an unconfigured history draft only. Never change another root.
      const draft = statuses.length === 1 ? statuses[0] : undefined;
      if (statuses.length > 1) return;
      const id = draft?.id ?? crypto.randomUUID();
      const waiting = 'waitingForSync' in proposal;
      db.prepare(
        `INSERT INTO historical_download_access(id,server_id,arr_instance_id,configuration,revision,status,sample,reason,checked_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        configuration=excluded.configuration,revision=excluded.revision,status=excluded.status,sample=excluded.sample,
        reason=excluded.reason,checked_at=excluded.checked_at,problem_revision=NULL,dismissed_revision=NULL`,
      )
        .run(
          id,
          serverId,
          instanceId,
          JSON.stringify({
            enabled: false,
            noRemainingClient: false,
            remoteRoot: waiting ? '' : proposal.remoteRoot,
            localRoot: waiting ? '' : proposal.localRoot,
          }),
          crypto.randomUUID(),
          waiting ? 'waiting_for_sync' : 'ready_to_enable',
          waiting ? null : proposal.sample,
          JSON.stringify({ setupConnectionRevision: proposal.connectionRevision }),
          Date.now(),
        );
    });
  })().catch(() => {}).finally(() => {
    pending.delete(key);
    pendingSignals.delete(key);
  });
  pending.set(key, work);
  return await work;
}

/** Called only after a successful relevant sync. Claim durable work before I/O so
 * restarts, repeated syncs and concurrent callbacks cannot replay discovery. */
export async function resumeHistoricalSetupAfterSync(
  serverId: number,
  libraryKey: string | null,
  inspect = probe,
): Promise<void> {
  const records = withTransaction((db) =>
    db.prepare(
      `SELECT a.id,a.arr_instance_id,a.revision,a.reason FROM historical_download_access a
    WHERE a.server_id=? AND a.status='waiting_for_sync' AND EXISTS (
      SELECT 1 FROM arr_library_mappings m WHERE m.server_id=a.server_id
      AND m.arr_instance_id=a.arr_instance_id AND (? IS NULL OR m.library_key=?)) LIMIT 20`,
    ).values<[string, number, string, string]>(serverId, libraryKey, libraryKey)
  );
  for (const [id, instanceId, revision, reason] of records) {
    // Keep the durable attempt unclaimed until discovery can start. These
    // bounded probes release their slots before resolving; no await separates
    // this capacity check, the revision-guarded claim and discovery registration.
    const key = `${serverId}:${instanceId}`;
    while (pending.has(key) || pending.size >= 4) {
      await (pending.get(key) ?? Promise.race(pending.values()));
    }
    const claimed = withTransaction((db) =>
      db.prepare(
        `UPDATE historical_download_access SET status='not_enabled',reason=NULL
      WHERE server_id=? AND id=? AND revision=? AND status='waiting_for_sync' RETURNING id`,
      ).value<[string]>(serverId, id, revision)
    );
    if (!claimed) continue;
    let expected: string | undefined;
    try {
      expected = JSON.parse(reason).setupConnectionRevision;
    } catch {
      continue;
    }
    if (context(serverId, instanceId)?.revision !== expected) continue;
    await discoverHistoricalSetup(serverId, instanceId, async (server, instance) => {
      const proposal = await inspect(server, instance);
      // An empty successful sync consumes this attempt too; manual retry remains.
      return proposal && !('waitingForSync' in proposal) ? proposal : null;
    });
  }
}

/** Explicit consent, fresh proof and a revision compare before enabling. */
export async function enableHistoricalSetup(
  serverId: number,
  id: string,
  revision: string,
  inspect = probe,
) {
  const saved = listHistoricalAccess(serverId).find((s) =>
    s.id === id && s.revision === revision && s.status === 'ready_to_enable'
  );
  if (!saved) throw new Error('Folder setup changed. Review setup again.');
  const proof = withTransaction((db) =>
    db.prepare(
      'SELECT reason FROM historical_download_access WHERE server_id=? AND id=? AND revision=?',
    ).value<[string]>(serverId, id, revision)
  );
  if (
    !proof ||
    JSON.parse(proof[0] ?? '{}').setupConnectionRevision !==
      context(serverId, saved.instanceId)?.revision
  ) {
    throw new Error('Connection settings changed. Review setup again.');
  }
  const proposal = await boundedHistoricalInspection(inspect(serverId, saved.instanceId), 25_000)
    .catch(() => null);
  if (
    !proposal || 'waitingForSync' in proposal ||
    proposal.localRoot !== saved.configuration.localRoot ||
    proposal.remoteRoot !== saved.configuration.remoteRoot
  ) {
    withTransaction((db) =>
      db.prepare(
        "UPDATE historical_download_access SET status='not_enabled',reason=NULL WHERE server_id=? AND id=? AND revision=?",
      )
        .run(serverId, id, revision)
    );
    throw new Error('Folder access could not be verified. Use Set up to review the paths.');
  }
  const current = listHistoricalAccess(serverId).find((s) =>
    s.id === id && s.revision === revision && s.status === 'ready_to_enable'
  );
  if (!current || context(serverId, saved.instanceId)?.revision !== proposal.connectionRevision) {
    throw new Error('Folder setup changed. Review setup again.');
  }
  withTransaction((db) => {
    db.prepare(
      `UPDATE historical_download_access SET configuration=?,revision=?,status='available',sample=?,reason=NULL,
      checked_at=?,succeeded_at=?,problem_revision=NULL,dismissed_revision=NULL WHERE server_id=? AND id=? AND revision=?`,
    )
      .run(
        JSON.stringify({ ...current.configuration, enabled: true, noRemainingClient: false }),
        crypto.randomUUID(),
        proposal.sample,
        Date.now(),
        Date.now(),
        serverId,
        id,
        revision,
      );
  });
}
