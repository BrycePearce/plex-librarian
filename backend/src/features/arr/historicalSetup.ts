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
    const sample = db.prepare(`SELECT CASE WHEN ?='radarr' THEN i.tmdb_id ELSE i.tvdb_id END
      FROM arr_library_mappings m JOIN items i ON i.server_id=m.server_id AND i.library_key=m.library_key
      WHERE m.server_id=? AND m.arr_instance_id=? AND
      (CASE WHEN ?='radarr' THEN i.tmdb_id ELSE i.tvdb_id END) IS NOT NULL LIMIT 1`)
      .value<[number]>(row[0], serverId, instanceId, row[0]);
    return {
      row,
      mappings,
      sample: sample?.[0],
      revision: serviceOwnedFingerprint([row, mappings]),
    };
  });
}

async function probe(serverId: number, instanceId: number) {
  const before = context(serverId, instanceId);
  if (!before?.sample) return null;
  const client = new ArrClient(...before.row);
  const title = await client.lookup(before.sample);
  if (!title) return null;
  const history = await client.historicalImports(title.id);
  if (history.problems.length) return null;
  const proposal = await probeHistoricalSetup(
    history.records,
    before.mappings,
    await historicalDownloadFolders(),
  );
  if (!proposal || context(serverId, instanceId)?.revision !== before.revision) return null;
  return { ...proposal, connectionRevision: before.revision };
}

const pending = new Map<string, Promise<void>>();
/** Trigger only on successful connection/configuration writes or explicit retry.
 * No startup, GET, polling or background retry trigger. */
export async function discoverHistoricalSetup(
  serverId: number,
  instanceId: number,
  inspect = probe,
): Promise<void> {
  const key = `${serverId}:${instanceId}`;
  if (pending.has(key)) return pending.get(key)!;
  if (pending.size >= 4) return Promise.resolve();
  const statuses = listHistoricalAccess(serverId).filter((s) => s.instanceId === instanceId);
  // Never rewrite a user's saved setup, including intentionally disabled folders.
  if (statuses.some((s) => s.configuration.localRoot && s.status !== 'ready_to_enable')) {
    return Promise.resolve();
  }
  // Withdraw a previous offer immediately when connection settings change.
  for (const status of statuses.filter((s) => s.status === 'ready_to_enable')) {
    withTransaction((db) =>
      db.prepare(
        "UPDATE historical_download_access SET status='not_enabled',reason=NULL WHERE id=? AND revision=?",
      )
        .run(status.id, status.revision)
    );
  }
  const snapshot = serviceOwnedFingerprint(
    listHistoricalAccess(serverId).filter((s) => s.instanceId === instanceId),
  );
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
      db.prepare(
        `INSERT INTO historical_download_access(id,server_id,arr_instance_id,configuration,revision,status,sample,reason,checked_at)
        VALUES(?,?,?,?,?,'ready_to_enable',?,?,?) ON CONFLICT(id) DO UPDATE SET
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
            remoteRoot: proposal.remoteRoot,
            localRoot: proposal.localRoot,
          }),
          crypto.randomUUID(),
          proposal.sample,
          JSON.stringify({ setupConnectionRevision: proposal.connectionRevision }),
          Date.now(),
        );
    });
  })().catch(() => {}).finally(() => pending.delete(key));
  pending.set(key, work);
  return await work;
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
    !proposal || proposal.localRoot !== saved.configuration.localRoot ||
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
