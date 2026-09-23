import { dirname, resolve } from 'node:path';
import { withTransaction } from '../../db/index.ts';
import type {
  HistoricalAccessConfiguration,
  HistoricalAccessDiagnostic,
  HistoricalAccessStatus,
} from '../../../../shared/historicalDownloads.ts';
import {
  boundedHistoricalInspection,
  HistoricalAccessError,
  inspectHistoricalAccessSample,
} from './historicalAccessInspection.ts';
import type { ArrPathMapping } from '../../../../shared/types.ts';
import { serviceOwnedFingerprint } from '../mediaDeletion/serviceOwnedPlanning.ts';
import { ArrClient } from '../../integrations/arr/client.ts';

export const historicalAppDataRoot = () =>
  dirname(resolve(Deno.env.get('DB_PATH') ?? './data/librarian.db'));
function accessReason(
  value: unknown,
): { reason: string | null; diagnostic?: HistoricalAccessDiagnostic } {
  if (typeof value !== 'string') return { reason: null };
  try {
    const diagnostic = JSON.parse(value);
    if (
      diagnostic &&
      [
        'missing_root',
        'access_denied',
        'read_only',
        'sample_absent',
        'timeout',
        'unsupported',
        'invalid_folder',
      ].includes(diagnostic.code)
    ) {
      return { reason: null, diagnostic };
    }
  } catch { /* Older records contain plain-text diagnostics. */ }
  return { reason: value };
}
export function listHistoricalAccess(serverId: number): HistoricalAccessStatus[] {
  return withTransaction((db) =>
    db.prepare(
      'SELECT id, arr_instance_id, configuration, revision, status, sample, reason, CAST(checked_at AS REAL), CAST(succeeded_at AS REAL), problem_revision, dismissed_revision FROM historical_download_access WHERE server_id=?',
    ).values<unknown[]>(serverId)
  )
    .map((r) => ({
      id: r[0] as string,
      instanceId: r[1] as number,
      configuration: JSON.parse(r[2] as string),
      revision: r[3] as string,
      status: r[4] as HistoricalAccessStatus['status'],
      sample: r[5] as string | null,
      ...accessReason(r[6]),
      checkedAt: r[7] as number | null,
      succeededAt: r[8] as number | null,
      problemRevision: r[9] as string | null,
      dismissedRevision: r[10] as string | null,
    }));
}

export function historicalTranslation(
  source: string,
  config: HistoricalAccessConfiguration,
): string {
  const { remoteRoot, localRoot } = config;
  if (
    !source.startsWith(remoteRoot + '/') ||
    source.split('/').some((s) => s === '..' || s === '.') ||
    source.includes('\\') || [...source].some((c) => c.charCodeAt(0) < 32)
  ) throw new Error('No unambiguous saved translation for this exact source');
  return localRoot + source.slice(remoteRoot.length);
}

export function saveHistoricalAccess(
  serverId: number,
  instanceId: number,
  raw: HistoricalAccessConfiguration,
  recordId?: string,
) {
  if (
    typeof raw.enabled !== 'boolean' || typeof raw.noRemainingClient !== 'boolean' ||
    ![raw.remoteRoot, raw.localRoot].every((p) =>
      typeof p === 'string' && p.startsWith('/') && p !== '/' &&
      p === p.trim() && !p.endsWith('/') && !p.includes('//') && !p.includes('\\') &&
      ![...p].some((c) => c.charCodeAt(0) < 32) &&
      !p.split('/').some((s) => s === '.' || s === '..')
    )
  ) throw new Error('Provide exact absolute service and Librarian roots');
  const revision = crypto.randomUUID();
  const statuses = listHistoricalAccess(serverId);
  const existing = recordId === undefined
    ? statuses.find((s) =>
      s.instanceId === instanceId && s.configuration.remoteRoot === raw.remoteRoot
    )
    : statuses.find((s) => s.id === recordId && s.instanceId === instanceId);
  if (recordId !== undefined && !existing) {
    throw new Error('Access record not found for this media connection');
  }
  if (
    statuses.some((s) =>
      s.instanceId === instanceId && s.id !== existing?.id &&
      s.configuration.remoteRoot === raw.remoteRoot
    )
  ) {
    throw new Error('This service download root already has an access record');
  }
  // Record identity stays stable when a suggested root is corrected. Its revision
  // invalidates prior previews and any access check still in flight.
  const proposedId = `${serverId}:${instanceId}:${raw.remoteRoot}`;
  const id = existing?.id ??
    (statuses.some((s) => s.id === proposedId) ? crypto.randomUUID() : proposedId);
  if (statuses.length >= 20 && !statuses.some((s) => s.id === id)) {
    throw new Error('At most 20 download roots are supported');
  }
  withTransaction((db) => {
    if (
      !db.prepare(
        "SELECT 1 FROM arr_instances WHERE id=? AND server_id=? AND type IN ('sonarr','radarr')",
      ).value(
        instanceId,
        serverId,
      )
    ) throw new Error('Media connection not found');
    db.prepare(
      `INSERT INTO historical_download_access(id,server_id,arr_instance_id,configuration,revision,status) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,revision=excluded.revision,status=excluded.status,reason=NULL,checked_at=NULL,succeeded_at=NULL,problem_revision=NULL,dismissed_revision=NULL`,
    ).run(
      id,
      serverId,
      instanceId,
      JSON.stringify(raw),
      revision,
      raw.enabled ? 'waiting_for_sample' : 'not_enabled',
    );
    if (existing?.sample && !existing.sample.startsWith(raw.remoteRoot + '/')) {
      db.prepare('UPDATE historical_download_access SET sample=NULL WHERE id=?').run(id);
    }
  });
  void checkHistoricalAccess(serverId, id).catch(() => {});
}

const pending = new Map<string, Promise<void>>();
const retryDelay = new Map<string, number>();
let queue = Promise.resolve();
export function checkHistoricalAccess(
  serverId: number,
  id: string,
  inspectSample = inspectHistoricalAccessSample,
): Promise<void> {
  const status = listHistoricalAccess(serverId).find((s) => s.id === id);
  if (!status?.configuration.enabled) return Promise.resolve();
  const key = `${id}:${status.revision}`;
  if (pending.has(key)) return pending.get(key)!;
  if (pending.size >= 40) return Promise.resolve();
  const work = queue.catch(() => {}).then(async () => {
    if (
      !listHistoricalAccess(serverId).some((s) =>
        s.id === id && s.revision === status.revision && s.configuration.enabled
      )
    ) return;
    let sample = status.sample;
    let state: HistoricalAccessStatus['status'] = 'available';
    let reason: string | null = null;
    withTransaction((db) =>
      db.prepare(
        "UPDATE historical_download_access SET status='checking' WHERE id=? AND revision=?",
      ).run(id, status.revision)
    );
    try {
      if (!sample) {
        const row = withTransaction((db) =>
          db.prepare(
            `SELECT a.url,a.api_key,CASE WHEN a.type='radarr' THEN i.tmdb_id ELSE i.tvdb_id END,a.type FROM arr_instances a
          JOIN arr_library_mappings m ON m.arr_instance_id=a.id AND m.server_id=a.server_id
          JOIN items i ON i.server_id=m.server_id AND i.library_key=m.library_key
          WHERE a.server_id=? AND a.id=? AND (CASE WHEN a.type='radarr' THEN i.tmdb_id ELSE i.tvdb_id END) IS NOT NULL LIMIT 1`,
          ).value<
            [string, string, number, 'sonarr' | 'radarr']
          >(serverId, status.instanceId)
        );
        if (row) {
          const client = new ArrClient(row[3], row[0], row[1]);
          const series = await client.lookup(row[2]);
          if (series) {
            sample = (await client.historicalImports(series.id)).records.find((r) =>
              r.droppedPath.startsWith(status.configuration.remoteRoot + '/')
            )?.droppedPath ?? null;
          }
        }
      }
      if (!sample) {
        state = 'waiting_for_sample';
        reason =
          'No exact history-linked file is available to check yet. Sync or open a deletion preview.';
      } else {
        const local = historicalTranslation(sample, status.configuration);
        const diagnostic = await boundedHistoricalInspection(
          inspectSample(status.configuration.localRoot, local),
        );
        reason = diagnostic ? JSON.stringify(diagnostic) : null;
      }
    } catch (error) {
      state = status.succeededAt ? 'access_lost' : 'setup_needed';
      // Never copy remote exceptions (which may contain credentials) into feedback.
      reason = JSON.stringify(
        error instanceof HistoricalAccessError ? error.diagnostic : { code: 'unsupported' },
      );
    }
    const now = Date.now();
    if (state === 'available') retryDelay.delete(key);
    else retryDelay.set(key, Math.min(3600_000, (retryDelay.get(key) ?? 150_000) * 2));
    const problem = state === 'setup_needed' || state === 'access_lost'
      ? serviceOwnedFingerprint([status.revision, state, reason])
      : null;
    withTransaction((db) =>
      db.prepare(
        `UPDATE historical_download_access SET status=?,sample=?,reason=?,checked_at=?,succeeded_at=CASE WHEN ?='available' THEN ? ELSE succeeded_at END,problem_revision=? WHERE id=? AND revision=?`,
      ).run(state, sample, reason, now, state, now, problem, id, status.revision)
    );
  }).finally(() => {
    pending.delete(key);
  });
  queue = work.catch(() => {});
  pending.set(key, work);
  return work;
}

export function supplyHistoricalSample(
  serverId: number,
  instanceId: number,
  source: string,
  mappings: readonly ArrPathMapping[] = [],
) {
  if (
    !listHistoricalAccess(serverId).some((s) =>
      s.instanceId === instanceId && source.startsWith(s.configuration.remoteRoot + '/')
    )
  ) {
    const matches = mappings.filter((m) =>
      m.kind === 'download' && source.startsWith(m.arrPath + '/')
    );
    const mapping = matches.length === 1 ? matches[0] : null;
    // An unresolved sample explains setup for this connection; do not fill the
    // root budget with one draft for every release discovered in a season.
    if (
      !mapping &&
      listHistoricalAccess(serverId).some((s) =>
        s.instanceId === instanceId && !s.configuration.enabled && !s.configuration.localRoot
      )
    ) return;
    const remoteRoot = mapping?.arrPath ?? dirname(source);
    const proposedId = `${serverId}:${instanceId}:${remoteRoot}`;
    // An edited record keeps its identity even after moving to another root.
    // Do not let that old identity suppress discovery of an uncovered root.
    const id = listHistoricalAccess(serverId).some((s) => s.id === proposedId)
      ? crypto.randomUUID()
      : proposedId;
    if (listHistoricalAccess(serverId).length >= 20) return;
    withTransaction((db) =>
      db.prepare(
        'INSERT OR IGNORE INTO historical_download_access(id,server_id,arr_instance_id,configuration,revision,status,sample,reason) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        id,
        serverId,
        instanceId,
        JSON.stringify({
          enabled: !!mapping,
          remoteRoot,
          localRoot: mapping?.localPath ?? '',
          noRemainingClient: false,
        }),
        crypto.randomUUID(),
        mapping ? 'waiting_for_sample' : 'setup_needed',
        source,
        mapping
          ? null
          : `The service reports ${source}. No unambiguous translation exists; no Librarian path was attempted. Choose the corresponding completed-downloads host folder.`,
      )
    );
  }
  for (
    const status of listHistoricalAccess(serverId).filter((s) =>
      s.instanceId === instanceId && source.startsWith(s.configuration.remoteRoot + '/')
    )
  ) {
    if (status.sample === null) {
      withTransaction((db) =>
        db.prepare('UPDATE historical_download_access SET sample=? WHERE id=? AND revision=?').run(
          source,
          status.id,
          status.revision,
        )
      );
    }
    if (
      status.status !== 'available' && (status.checkedAt === null ||
        Date.now() - status.checkedAt >
          (retryDelay.get(`${status.id}:${status.revision}`) ?? 300_000))
    ) {
      void checkHistoricalAccess(serverId, status.id).catch(() => {});
    }
  }
}

export function scheduleHistoricalAccessChecks(serverId: number, force = false) {
  for (const status of listHistoricalAccess(serverId)) {
    if (
      force || status.configuration.enabled && status.status !== 'available' &&
        Date.now() - (status.checkedAt ?? 0) >
          (retryDelay.get(`${status.id}:${status.revision}`) ?? 300_000)
    ) void checkHistoricalAccess(serverId, status.id).catch(() => {});
  }
}

export function invalidateHistoricalAccessConfiguration(serverId: number) {
  withTransaction((db) => {
    for (
      const [id, raw] of db.prepare(
        'SELECT id,configuration FROM historical_download_access WHERE server_id=?',
      ).values<[string, string]>(serverId)
    ) {
      const configuration = JSON.parse(raw) as HistoricalAccessConfiguration;
      configuration.noRemainingClient = false;
      db.prepare(
        'UPDATE historical_download_access SET configuration=?,revision=?,sample=NULL,checked_at=NULL,status=?,problem_revision=NULL,dismissed_revision=NULL WHERE id=?',
      )
        .run(
          JSON.stringify(configuration),
          crypto.randomUUID(),
          configuration.enabled ? 'waiting_for_sample' : 'not_enabled',
          id,
        );
    }
  });
  scheduleHistoricalAccessChecks(serverId, true);
}

export function checkActiveHistoricalAccess(force = false) {
  const serverId = withTransaction((db) =>
    db.prepare('SELECT active_server_id FROM settings WHERE id=1').value<[number | null]>()?.[0]
  );
  if (serverId) {
    scheduleHistoricalAccessChecks(serverId, force);
    const statuses = listHistoricalAccess(serverId);
    if (force || !statuses.length || statuses.some((s) => s.status === 'waiting_for_sample')) {
      void discoverHistoricalAccess(serverId);
    }
  }
}

const discovering = new Map<number, Promise<void>>();
/** One bounded current title per connected service, never a startup walk of series histories. */
export function discoverHistoricalAccess(serverId: number): Promise<void> {
  if (discovering.has(serverId)) return discovering.get(serverId)!;
  const work = (async () => {
    const connections = withTransaction((db) =>
      db.prepare(
        "SELECT id,url,api_key,updated_at,type FROM arr_instances WHERE server_id=? AND type IN ('sonarr','radarr') ORDER BY id LIMIT 20",
      ).values<[number, string, string, number, 'sonarr' | 'radarr']>(serverId)
    );
    for (const [instanceId, url, apiKey, revision, type] of connections) {
      try {
        const sample = withTransaction((db) =>
          db.prepare(
            `SELECT i.${
              type === 'radarr' ? 'tmdb_id' : 'tvdb_id'
            } FROM items i JOIN arr_library_mappings m ON m.server_id=i.server_id AND m.library_key=i.library_key WHERE m.server_id=? AND m.arr_instance_id=? AND i.${
              type === 'radarr' ? 'tmdb_id' : 'tvdb_id'
            } IS NOT NULL LIMIT 1`,
          ).value<[number]>(serverId, instanceId)
        );
        if (!sample) continue;
        const client = new ArrClient(type, url, apiKey);
        const series = await client.lookup(sample[0]);
        if (!series) continue;
        const history = await client.historicalImports(series.id);
        const source = history.records[0]?.droppedPath;
        if (!source) continue;
        const unchanged = withTransaction((db) =>
          db.prepare(
            'SELECT 1 FROM arr_instances WHERE id=? AND server_id=? AND url=? AND api_key=? AND updated_at=?',
          ).value(instanceId, serverId, url, apiKey, revision)
        );
        if (!unchanged) continue;
        const mappings = withTransaction((db) =>
          db.prepare(
            'SELECT kind,arr_path,local_path FROM arr_path_mappings WHERE arr_instance_id=?',
          ).values<[ArrPathMapping['kind'], string, string]>(instanceId)
        ).map(([kind, arrPath, localPath]) => ({ kind, arrPath, localPath }));
        supplyHistoricalSample(serverId, instanceId, source, mappings);
      } catch { /* Optional sample reads never block connecting or using service deletion. */ }
    }
  })().catch(() => {}).finally(() => {
    discovering.delete(serverId);
  });
  discovering.set(serverId, work);
  return work;
}
