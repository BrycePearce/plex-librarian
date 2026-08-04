import { activeLibraryOperation } from '../../services/libraryOperations.ts';
import { type SqliteClient, withTransaction } from '../../db/index.ts';
import { activeServerMatches } from './coordination.ts';
import { isRetryableDeletionFailure } from './policy.ts';
import { recoverInterruptedDeletionWork } from './recovery.ts';
import { refreshDeletionOperation } from './state.ts';
import {
  DeletionConvergenceError,
  type DeletionWorkTarget,
  PlexReconciliationError,
} from './types.ts';
import { DeletionValidationError } from './validation.ts';
import { ensureDeletionTarget } from './workflow.ts';

export type DeletionKind = 'whole_item' | 'movie_version' | 'episode_version';
export type DeletionOperationStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'completed'
  | 'completed_with_warning'
  | 'needs_attention'
  | 'cancelled';

export interface NewDeletionTarget {
  kind: DeletionKind;
  key: string;
  title: string;
  logicalSize: number | null;
  snapshot: Record<string, unknown>;
  reservation?: { mediaKind: 'movie' | 'episode'; mediaId: number; ratingKey: string };
}

export interface NewDeletionOperation {
  clientRequestId: string;
  serverId: number;
  libraryKey: string;
  kind: DeletionKind;
  payload: Record<string, unknown>;
  targets: NewDeletionTarget[];
}

export class DeletionConflictError extends Error {
  constructor(message: string, readonly status = 409, readonly operationId?: string) {
    super(message);
  }
}

export function locallyActiveServerId(): number | null {
  return withTransaction((client) =>
    client.prepare('SELECT active_server_id FROM settings WHERE id = 1').value<[number | null]>()
      ?.[0] ?? null
  );
}

export function findWarningOverlap(
  serverId: number,
  requestedKind: DeletionKind,
  ratingKeys: readonly string[],
  mediaIds: readonly number[] = [],
): string | null {
  const requestedMedia = new Set(mediaIds);
  return withTransaction((client) => {
    const requestedRoots = new Set(ratingKeys);
    if (ratingKeys.length > 0) {
      const placeholders = ratingKeys.map(() => '?').join(',');
      for (
        const [showRatingKey] of client.prepare(
          `SELECT DISTINCT show_rating_key FROM episode_media_versions
           WHERE server_id = ? AND episode_rating_key IN (${placeholders})`,
        ).values<[string]>(serverId, ...ratingKeys)
      ) requestedRoots.add(showRatingKey);
    }
    const rows = client.prepare(
      `SELECT t.operation_id, t.target_kind, t.snapshot
       FROM deletion_targets t
       JOIN deletion_operations o ON o.id = t.operation_id
       WHERE o.server_id = ? AND t.status = 'completed_with_warning'`,
    ).values<[string, DeletionKind, string]>(serverId);
    for (const [operationId, targetKind, rawSnapshot] of rows) {
      const snapshot = JSON.parse(rawSnapshot) as {
        ratingKey?: string;
        showRatingKey?: string | null;
        mediaId?: number;
        arrReassignments?: Array<{ retainedMediaId?: number }>;
      };
      const warningRoots = [snapshot.ratingKey, snapshot.showRatingKey].filter(
        (value): value is string => typeof value === 'string',
      );
      if (!warningRoots.some((root) => requestedRoots.has(root))) continue;
      if (requestedKind === 'whole_item' || targetKind === 'whole_item') return operationId;
      if (snapshot.mediaId !== undefined && requestedMedia.has(snapshot.mediaId)) {
        return operationId;
      }
      if (
        snapshot.arrReassignments?.some((entry) =>
          entry.retainedMediaId !== undefined && requestedMedia.has(entry.retainedMediaId)
        )
      ) return operationId;
    }
    return null;
  });
}

const RETRY_DELAYS = [60, 300, 1800];
const PLEX_RETRY_DELAYS = [15, 60, 300];
let workerRunning = false;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let automaticWake = true;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, item],
      ) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')
    }}`;
  }
  return JSON.stringify(value);
}

async function requestHash(payload: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function repeatedDeletionOperation(
  serverId: number,
  clientRequestId: string,
  payload: Record<string, unknown>,
): Promise<{ operationId: string; status: DeletionOperationStatus } | null> {
  const hash = await requestHash(payload);
  return withTransaction((client) => {
    const row = client.prepare(
      'SELECT id, request_hash, status FROM deletion_operations WHERE server_id = ? AND client_request_id = ?',
    ).value<[string, string, DeletionOperationStatus]>(serverId, clientRequestId);
    if (!row) return null;
    if (row[1] !== hash) {
      throw new DeletionConflictError('clientRequestId was already used with a different request');
    }
    return { operationId: row[0], status: row[2] };
  });
}

export async function repeatedDeletionOperationBatch(
  serverId: number,
  clientRequestId: string,
  payload: Record<string, unknown>,
): Promise<{ operationIds: string[]; targetCount: number } | null> {
  const hash = await requestHash(payload);
  const prefix = `${clientRequestId}:`;
  return withTransaction((client) => {
    const rows = client.prepare(
      `SELECT id, client_request_id, request_hash, target_count
       FROM deletion_operations
       WHERE server_id = ? AND substr(client_request_id, 1, ?) = ?`,
    ).values<[string, string, string, number]>(serverId, prefix.length, prefix);
    if (rows.length === 0) return null;
    const indexed = rows.map((row) => {
      const suffix = row[1].slice(prefix.length);
      if (!/^\d+$/.test(suffix) || row[2] !== hash) {
        throw new DeletionConflictError(
          'clientRequestId was already used with a different request',
        );
      }
      return { row, index: Number(suffix) };
    }).sort((left, right) => left.index - right.index);
    return {
      operationIds: indexed.map(({ row }) => row[0]),
      targetCount: indexed.reduce((total, { row }) => total + row[3], 0),
    };
  });
}

function ensureVersionCapacity(client: SqliteClient, input: NewDeletionOperation): void {
  const groups = new Map<
    string,
    { kind: 'movie' | 'episode'; ratingKey: string; ids: number[] }
  >();
  for (const target of input.targets) {
    if (!target.reservation) continue;
    const reservation = target.reservation;
    const key = `${reservation.mediaKind}:${reservation.ratingKey}`;
    const group = groups.get(key) ?? {
      kind: reservation.mediaKind,
      ratingKey: reservation.ratingKey,
      ids: [],
    };
    group.ids.push(reservation.mediaId);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const table = group.kind === 'movie' ? 'item_media_versions' : 'episode_media_versions';
    const ratingColumn = group.kind === 'movie' ? 'item_rating_key' : 'episode_rating_key';
    const total = client.prepare(
      `SELECT COUNT(*) FROM ${table} WHERE server_id = ? AND ${ratingColumn} = ?`,
    ).value<[number]>(input.serverId, group.ratingKey)?.[0] ?? 0;
    const reserved = client.prepare(
      'SELECT COUNT(*) FROM media_version_reservations WHERE server_id = ? AND media_kind = ? AND rating_key = ?',
    ).value<[number]>(input.serverId, group.kind, group.ratingKey)?.[0] ?? 0;
    if (total - reserved - group.ids.length < 1) {
      throw new DeletionConflictError(
        'at least one version must remain; delete the item instead',
        400,
      );
    }
  }
}

function snapshotArrMappingIdentities(
  client: SqliteClient,
  serverId: number,
  libraryKey: string,
  kind: 'movie_version' | 'episode_version',
): Array<Record<string, unknown>> {
  const expectedType = kind === 'movie_version' ? 'radarr' : 'sonarr';
  const rows = client.prepare(
    `SELECT i.id, i.type, i.url, i.updated_at, m.add_import_exclusion
     FROM arr_library_mappings m
     JOIN arr_instances i ON i.id = m.arr_instance_id
     WHERE m.server_id = ? AND m.library_key = ?
       AND i.server_id = ? AND i.type = ?
     ORDER BY i.id`,
  ).values<[number, 'radarr' | 'sonarr', string, number, number]>(
    serverId,
    libraryKey,
    serverId,
    expectedType,
  );
  return rows.map(([instanceId, instanceType, instanceUrl, configurationUpdatedAt, exclusion]) => {
    const pathMappings = client.prepare(
      `SELECT kind, arr_path, local_path
       FROM arr_path_mappings
       WHERE arr_instance_id = ?
       ORDER BY kind, arr_path, local_path`,
    ).values<['library' | 'download', string, string]>(instanceId).map(
      ([mappingKind, arrPath, localPath]) => ({
        kind: mappingKind,
        arrPath,
        localPath,
      }),
    ).sort((left, right) =>
      `${left.kind}\0${left.arrPath}\0${left.localPath}`.localeCompare(
        `${right.kind}\0${right.arrPath}\0${right.localPath}`,
      )
    );
    return {
      instanceId,
      instanceType,
      instanceUrl,
      configurationUpdatedAt,
      mappingIdentity: JSON.stringify({
        addImportExclusion: Boolean(exclusion),
        pathMappings,
      }),
    };
  });
}

function projectionRoot(target: NewDeletionTarget): string | null {
  if (target.kind === 'episode_version') {
    return typeof target.snapshot.showRatingKey === 'string' ? target.snapshot.showRatingKey : null;
  }
  return typeof target.snapshot.ratingKey === 'string' ? target.snapshot.ratingKey : null;
}

function ensureNoRecoveryOverlap(client: SqliteClient, input: NewDeletionOperation): void {
  const unresolved = client.prepare(
    `SELECT t.operation_id, t.status, t.target_kind, t.target_key, t.snapshot
     FROM deletion_targets t
     JOIN deletion_operations o ON o.id = t.operation_id
     WHERE o.server_id = ? AND o.library_key = ? AND t.status IN ('needs_attention','completed_with_warning')`,
  ).values<[string, 'needs_attention' | 'completed_with_warning', DeletionKind, string, string]>(
    input.serverId,
    input.libraryKey,
  ).map((row) => {
    const snapshot = JSON.parse(row[4]) as Record<string, unknown>;
    const root = row[2] === 'episode_version'
      ? (typeof snapshot.showRatingKey === 'string' ? snapshot.showRatingKey : null)
      : (typeof snapshot.ratingKey === 'string' ? snapshot.ratingKey : null);
    const reassignments = Array.isArray(snapshot.arrReassignments)
      ? snapshot.arrReassignments as Array<Record<string, unknown>>
      : [];
    const protectedMediaIds = new Set(
      reassignments.flatMap((entry) =>
        typeof entry.retainedMediaId === 'number' ? [entry.retainedMediaId] : []
      ),
    );
    return {
      operationId: row[0],
      status: row[1],
      kind: row[2],
      key: row[3],
      root,
      protectedMediaIds,
    };
  });

  for (const target of input.targets) {
    const root = projectionRoot(target);
    const mediaId = target.reservation?.mediaId ?? null;
    const overlap = unresolved.find((existing) =>
      existing.key === target.key ||
      (root !== null && existing.root === root &&
        (existing.kind === 'whole_item' || target.kind === 'whole_item' ||
          (mediaId !== null && existing.protectedMediaIds.has(mediaId))))
    );
    if (overlap) {
      throw new DeletionConflictError(
        overlap.status === 'completed_with_warning'
          ? 'this item has unresolved Plex cleanup; retry Plex cleanup from Activity first'
          : 'this item has a deletion target that needs attention; retry it from Activity first',
        409,
        overlap.operationId,
      );
    }
  }
}

export async function enqueueDeletionOperation(
  input: NewDeletionOperation,
): Promise<{ operationId: string; status: 'queued' }> {
  const [result] = await enqueueDeletionOperations([input]);
  return result!;
}

export async function enqueueDeletionOperations(
  inputs: readonly NewDeletionOperation[],
): Promise<Array<{ operationId: string; status: 'queued' }>> {
  if (inputs.length === 0) {
    throw new DeletionConflictError('no deletion operations were provided', 400);
  }
  const requestIds = new Set<string>();
  for (const input of inputs) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.clientRequestId)) {
      throw new DeletionConflictError(
        'clientRequestId must be a non-empty string of at most 128 characters',
        400,
      );
    }
    if (input.targets.length === 0) {
      throw new DeletionConflictError('no deletion targets were found', 404);
    }
    const requestKey = `${input.serverId}:${input.clientRequestId}`;
    if (requestIds.has(requestKey)) {
      throw new DeletionConflictError(
        'clientRequestId must be unique within a deletion batch',
        400,
      );
    }
    requestIds.add(requestKey);
  }
  const prepared = await Promise.all(
    inputs.map(async (input) => ({
      input,
      hash: await requestHash(input.payload),
      operationId: crypto.randomUUID(),
    })),
  );
  const now = Math.floor(Date.now() / 1000);
  const ids = withTransaction((client) => {
    const accepted: string[] = [];
    for (const { input, hash, operationId } of prepared) {
      if (!activeServerMatches(client, input.serverId)) {
        throw new DeletionConflictError(
          'the active Plex server changed before deletion was accepted',
        );
      }
      const repeated = client.prepare(
        'SELECT id, request_hash FROM deletion_operations WHERE server_id = ? AND client_request_id = ?',
      ).value<[string, string]>(input.serverId, input.clientRequestId);
      if (repeated) {
        if (repeated[1] !== hash) {
          throw new DeletionConflictError(
            'clientRequestId was already used with a different request',
          );
        }
        accepted.push(repeated[0]);
        continue;
      }
      if (
        client.prepare(
          "SELECT id FROM sync_log WHERE server_id = ? AND status = 'pending' AND (library_key IS NULL OR library_key = ?) LIMIT 1",
        ).value<[number]>(input.serverId, input.libraryKey)
      ) {
        throw new DeletionConflictError('this library is currently syncing');
      }
      if (
        client.prepare(
          "SELECT id FROM deletion_operations WHERE server_id = ? AND library_key = ? AND status IN ('queued','running','waiting_retry') LIMIT 1",
        ).value<[string]>(input.serverId, input.libraryKey)
      ) {
        throw new DeletionConflictError('this library already has an active deletion operation');
      }
      if (activeLibraryOperation(input.serverId, input.libraryKey) !== null) {
        throw new DeletionConflictError('this library is currently syncing or being modified');
      }
      ensureNoRecoveryOverlap(client, input);
      ensureVersionCapacity(client, input);
      for (const target of input.targets) {
        if (target.kind === 'whole_item') continue;
        target.snapshot.arrReassignmentMappings = snapshotArrMappingIdentities(
          client,
          input.serverId,
          input.libraryKey,
          target.kind,
        );
      }
      client.prepare(
        "INSERT INTO deletion_operations (id, client_request_id, request_hash, server_id, library_key, kind, status, target_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
      ).run(
        operationId,
        input.clientRequestId,
        hash,
        input.serverId,
        input.libraryKey,
        input.kind,
        input.targets.length,
        now,
        now,
      );
      for (const [ordinal, target] of input.targets.entries()) {
        const row = client.prepare(
          'INSERT INTO deletion_targets (operation_id, ordinal, target_kind, target_key, title, snapshot, logical_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
        ).value<[number]>(
          operationId,
          ordinal,
          target.kind,
          target.key,
          target.title,
          JSON.stringify(target.snapshot),
          target.logicalSize,
          now,
          now,
        );
        if (!row) throw new Error('deletion target insert returned no id');
        if (target.reservation) {
          client.prepare(
            'INSERT INTO media_version_reservations (server_id, media_kind, media_id, rating_key, operation_id, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(
            input.serverId,
            target.reservation.mediaKind,
            target.reservation.mediaId,
            target.reservation.ratingKey,
            operationId,
            row[0],
            now,
          );
        }
      }
      accepted.push(operationId);
    }
    return accepted;
  });
  wakeDeletionWorker();
  return ids.map((operationId) => ({ operationId, status: 'queued' }));
}

function claimTarget(): DeletionWorkTarget | null {
  return withTransaction((client) => {
    const now = Math.floor(Date.now() / 1000);
    const row = client.prepare(
      `SELECT t.id, t.operation_id, o.server_id, t.target_kind, t.target_key, t.snapshot, t.logical_size,
              t.phase, t.removal_confirmed_at, t.plex_attempt_count
       FROM deletion_targets t JOIN deletion_operations o ON o.id = t.operation_id
       WHERE (t.status = 'queued' OR (t.status = 'waiting_retry' AND t.next_retry_at <= ?))
         AND (
           json_extract(t.snapshot, '$.arrReassignments') IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM deletion_targets prior
             WHERE prior.operation_id = t.operation_id
               AND prior.ordinal < t.ordinal
               AND prior.status IN ('queued', 'running', 'waiting_retry')
           )
         )
       ORDER BY o.created_at, t.ordinal LIMIT 1`,
    ).value<[
      number,
      string,
      number,
      DeletionKind,
      string,
      string,
      number | null,
      DeletionWorkTarget['phase'],
      number | null,
      number,
    ]>(now);
    if (!row) return null;
    client.prepare(
      "UPDATE deletion_targets SET status = 'running', attempt_count = attempt_count + 1, next_retry_at = NULL, error = NULL, updated_at = ? WHERE id = ?",
    ).run(now, row[0]);
    client.prepare(
      "UPDATE deletion_operations SET status = 'running', started_at = COALESCE(started_at, ?), next_retry_at = NULL, updated_at = ? WHERE id = ?",
    ).run(now, now, row[1]);
    return {
      id: row[0],
      operationId: row[1],
      serverId: row[2],
      targetKind: row[3],
      targetKey: row[4],
      snapshot: row[5],
      logicalSize: row[6],
      phase: row[7],
      removalConfirmedAt: row[8],
      plexAttemptCount: row[9],
    };
  });
}

function failTarget(target: DeletionWorkTarget, error: unknown): void {
  withTransaction((client) => {
    const now = Math.floor(Date.now() / 1000);
    const attempt =
      client.prepare('SELECT attempt_count FROM deletion_targets WHERE id = ?').value<[number]>(
        target.id,
      )?.[0] ?? 1;
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : null;
    const phaseRow = client.prepare(
      'SELECT phase, plex_attempt_count, removal_confirmed_at, snapshot FROM deletion_targets WHERE id = ?',
    ).value<[DeletionWorkTarget['phase'], number, number | null, string]>(target.id);
    const inPlexReconciliation = phaseRow?.[0] === 'plex_reconciliation';
    const permanent = error instanceof DeletionValidationError ||
      (error instanceof PlexReconciliationError && error.permanent);
    if (inPlexReconciliation && phaseRow) {
      const snapshot = JSON.parse(phaseRow[3]) as { mode?: string; arrReassignments?: unknown[] };
      const warningEligible =
        (target.targetKind === 'whole_item' && snapshot.mode === 'coordinated') ||
        (target.targetKind !== 'whole_item' && phaseRow[2] !== null &&
          Array.isArray(snapshot.arrReassignments) && snapshot.arrReassignments.length > 0);
      const warningAllowed = !(error instanceof PlexReconciliationError) || error.warningAllowed;
      if (!permanent && phaseRow[1] <= PLEX_RETRY_DELAYS.length) {
        const next = now + PLEX_RETRY_DELAYS[phaseRow[1] - 1];
        client.prepare(
          "UPDATE deletion_targets SET status = 'waiting_retry', next_retry_at = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running' AND phase = 'plex_reconciliation'",
        ).run(next, message, now, target.id);
      } else if (warningEligible && warningAllowed) {
        const warning = target.targetKind === 'whole_item'
          ? 'Arr removal completed; Plex removal was not confirmed. The item or other versions may remain.'
          : 'Media removed; Plex metadata needs attention.';
        client.prepare(
          "UPDATE deletion_targets SET status = 'completed_with_warning', next_retry_at = NULL, error = ?, warning = ?, updated_at = ? WHERE id = ? AND status = 'running' AND phase = 'plex_reconciliation'",
        ).run(message, warning, now, target.id);
      } else {
        client.prepare(
          "UPDATE deletion_targets SET status = 'needs_attention', next_retry_at = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'running' AND phase = 'plex_reconciliation'",
        ).run(message, now, target.id);
      }
      refreshDeletionOperation(client, target.operationId);
      return;
    }
    const retryable = !permanent &&
      (error instanceof DeletionConvergenceError ||
        isRetryableDeletionFailure(status, message, error instanceof TypeError));
    if (retryable && attempt <= RETRY_DELAYS.length) {
      const next = now + RETRY_DELAYS[attempt - 1];
      client.prepare(
        "UPDATE deletion_targets SET status = 'waiting_retry', next_retry_at = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      ).run(next, message, now, target.id);
    } else {
      client.prepare(
        "UPDATE deletion_targets SET status = 'needs_attention', next_retry_at = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      ).run(message, now, target.id);
      // A target with a persisted reassignment depends on the preceding targets'
      // projected state. Keep that dependency chain together for manual retry.
      client.prepare(
        `UPDATE deletion_targets
         SET status = 'needs_attention', next_retry_at = NULL,
             error = 'blocked because an earlier deletion target needs attention', updated_at = ?
         WHERE operation_id = ?
           AND ordinal > (SELECT ordinal FROM deletion_targets WHERE id = ?)
           AND status IN ('queued', 'waiting_retry')
           AND json_extract(snapshot, '$.arrReassignments') IS NOT NULL`,
      ).run(now, target.operationId, target.id);
    }
    refreshDeletionOperation(client, target.operationId);
  });
}

async function runWorker(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (true) {
      const target = claimTarget();
      if (!target) break;
      try {
        await ensureDeletionTarget(target);
      } catch (error) {
        failTarget(target, error);
      }
    }
  } finally {
    workerRunning = false;
    scheduleNextWake();
  }
}

function scheduleNextWake(): void {
  if (wakeTimer !== null) clearTimeout(wakeTimer);
  if (!automaticWake) {
    wakeTimer = null;
    return;
  }
  const retryAt = withTransaction((client) =>
    client.prepare(
      "SELECT MIN(next_retry_at) FROM deletion_targets WHERE status = 'waiting_retry'",
    ).value<[number | null]>()?.[0] ?? null
  );
  if (retryAt === null) {
    wakeTimer = null;
    return;
  }
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void runWorker();
  }, Math.max(0, retryAt * 1000 - Date.now()));
}

export function wakeDeletionWorker(): void {
  if (!automaticWake) return;
  queueMicrotask(() => void runWorker());
}

export function setAutomaticDeletionWorkerForTest(enabled: boolean): void {
  automaticWake = enabled;
}

export async function runDeletionWorkerOnceForTest(): Promise<void> {
  await runWorker();
}

export function startDeletionWorker(): void {
  withTransaction((client) =>
    recoverInterruptedDeletionWork(client, Math.floor(Date.now() / 1000))
  );
  wakeDeletionWorker();
}

export function getDeletionOperation(id: string, serverId: number): Record<string, unknown> | null {
  return withTransaction((client) => {
    const row = client.prepare(
      'SELECT id, client_request_id, library_key, kind, status, target_count, completed_count, warning_count, removal_confirmed_count, failed_count, logical_size_removed, next_retry_at, created_at, started_at, finished_at, updated_at FROM deletion_operations WHERE id = ? AND server_id = ?',
    ).value<unknown[]>(id, serverId);
    if (!row) return null;
    const keys = [
      'id',
      'clientRequestId',
      'libraryKey',
      'kind',
      'status',
      'targetCount',
      'completedCount',
      'warningCount',
      'removalConfirmedCount',
      'failedCount',
      'logicalSizeRemoved',
      'nextRetryAt',
      'createdAt',
      'startedAt',
      'finishedAt',
      'updatedAt',
    ];
    const result = Object.fromEntries(keys.map((key, index) => [key, row[index]]));
    result.targets = client.prepare(
      'SELECT id, ordinal, target_kind, target_key, title, status, attempt_count, phase, removal_confirmed_at, plex_reconciled_at, plex_attempt_count, warning, next_retry_at, error, logical_size, snapshot FROM deletion_targets WHERE operation_id = ? ORDER BY ordinal',
    ).values(id).map((target) => {
      const targetResult = Object.fromEntries([
        'id',
        'ordinal',
        'targetKind',
        'targetKey',
        'title',
        'status',
        'attemptCount',
        'phase',
        'removalConfirmedAt',
        'plexReconciledAt',
        'plexAttemptCount',
        'warning',
        'nextRetryAt',
        'error',
        'logicalSize',
      ].map((key, index) => [key, target[index]]));
      const snapshot = JSON.parse(String(target[15])) as {
        mode?: string;
        cleanupDownloads?: boolean;
        unmonitorFromArr?: boolean;
        arrOwnerships?: unknown[];
        arrReassignments?: unknown[];
      };
      targetResult.downloadCleanupSelected = snapshot.cleanupDownloads === true;
      targetResult.arrCoordinationConfigured = snapshot.mode === 'coordinated' ||
        snapshot.unmonitorFromArr === true ||
        (Array.isArray(snapshot.arrOwnerships) && snapshot.arrOwnerships.length > 0) ||
        (Array.isArray(snapshot.arrReassignments) && snapshot.arrReassignments.length > 0);
      return targetResult;
    });
    return result;
  });
}

export function cancelDeletionOperation(id: string, serverId: number): boolean {
  return withTransaction((client) => {
    const now = Math.floor(Date.now() / 1000);
    const queued = client.prepare(
      "SELECT id FROM deletion_targets WHERE operation_id = ? AND status = 'queued'",
    ).values<[number]>(id);
    if (
      queued.length === 0 || !client.prepare(
        'SELECT id FROM deletion_operations WHERE id = ? AND server_id = ?',
      ).value<[string]>(id, serverId)
    ) return false;
    for (const [targetId] of queued) {
      client.prepare(
        "UPDATE deletion_targets SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'",
      ).run(now, targetId);
      client.prepare('DELETE FROM media_version_reservations WHERE target_id = ?').run(targetId);
    }
    refreshDeletionOperation(client, id);
    return true;
  });
}

export function retryDeletionOperation(
  id: string,
  serverId: number,
  outcome: 'needs_attention' | 'warning' = 'needs_attention',
): boolean {
  return withTransaction((client) => {
    const now = Math.floor(Date.now() / 1000);
    const operation = client.prepare(
      'SELECT library_key FROM deletion_operations WHERE id = ? AND server_id = ?',
    ).value<[string]>(id, serverId);
    if (!operation || activeLibraryOperation(serverId, operation[0]) !== null) return false;
    if (!activeServerMatches(client, serverId)) return false;
    if (
      client.prepare(
        "SELECT id FROM deletion_operations WHERE id <> ? AND server_id = ? AND library_key = ? AND status IN ('queued','running','waiting_retry') LIMIT 1",
      ).value<[string]>(id, serverId, operation[0])
    ) return false;
    if (
      client.prepare(
        "SELECT id FROM sync_log WHERE server_id = ? AND status = 'pending' AND (library_key IS NULL OR library_key = ?) LIMIT 1",
      ).value<[number]>(serverId, operation[0])
    ) return false;
    const targetStatus = outcome === 'warning' ? 'completed_with_warning' : 'needs_attention';
    const matching = client.prepare(
      'SELECT COUNT(*) FROM deletion_targets WHERE operation_id = ? AND status = ?',
    ).value<[number]>(id, targetStatus)?.[0] ?? 0;
    if (matching === 0) return false;
    client.prepare(
      `UPDATE deletion_targets
       SET status = 'queued',
           attempt_count = CASE WHEN ? = 'needs_attention' THEN 0 ELSE attempt_count END,
           plex_attempt_count = CASE
             WHEN phase = 'plex_reconciliation'
              AND COALESCE(json_extract(snapshot, '$.arrReassignments[0].instanceType'), '') <> 'radarr'
             THEN 0
             ELSE plex_attempt_count
           END,
           next_retry_at = NULL,
           warning = CASE WHEN ? = 'warning' THEN NULL ELSE warning END,
           error = NULL,
           updated_at = ?
       WHERE operation_id = ? AND status = ?`,
    ).run(outcome, outcome, now, id, targetStatus);
    refreshDeletionOperation(client, id);
    return true;
  });
}
