import { activeLibraryOperation } from '../../services/libraryOperations.ts';
import { type SqliteClient, withTransaction } from '../../db/index.ts';
import { activeServerMatches } from './coordination.ts';
import { isRetryableDeletionFailure } from './policy.ts';
import { recoverInterruptedDeletionWork } from './recovery.ts';
import { refreshDeletionOperation } from './state.ts';
import { DeletionValidationError } from './validation.ts';
import {
  DeletionConvergenceError,
  type DeletionWorkTarget,
  ensureDeletionTarget,
} from './workflow.ts';

export type DeletionKind = 'whole_item' | 'movie_version' | 'episode_version';
export type DeletionOperationStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'completed'
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
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

const RETRY_DELAYS = [60, 300, 1800];
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

function ensureVersionCapacity(client: SqliteClient, input: NewDeletionOperation): void {
  const groups = new Map<string, { kind: 'movie' | 'episode'; ratingKey: string; ids: number[] }>();
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

function projectionRoot(target: NewDeletionTarget): string | null {
  if (target.kind === 'episode_version') {
    return typeof target.snapshot.showRatingKey === 'string' ? target.snapshot.showRatingKey : null;
  }
  return typeof target.snapshot.ratingKey === 'string' ? target.snapshot.ratingKey : null;
}

function ensureNoRecoveryOverlap(client: SqliteClient, input: NewDeletionOperation): void {
  const unresolved = client.prepare(
    `SELECT t.target_kind, t.target_key, t.snapshot
     FROM deletion_targets t
     JOIN deletion_operations o ON o.id = t.operation_id
     WHERE o.server_id = ? AND o.library_key = ? AND t.status = 'needs_attention'`,
  ).values<[DeletionKind, string, string]>(input.serverId, input.libraryKey).map((row) => {
    const snapshot = JSON.parse(row[2]) as Record<string, unknown>;
    const root = row[0] === 'episode_version'
      ? (typeof snapshot.showRatingKey === 'string' ? snapshot.showRatingKey : null)
      : (typeof snapshot.ratingKey === 'string' ? snapshot.ratingKey : null);
    return { kind: row[0], key: row[1], root };
  });

  for (const target of input.targets) {
    const root = projectionRoot(target);
    if (
      unresolved.some((existing) =>
        existing.key === target.key ||
        (root !== null && existing.root === root &&
          (existing.kind === 'whole_item' || target.kind === 'whole_item'))
      )
    ) {
      throw new DeletionConflictError(
        'this item has a deletion target that needs attention; retry it from Activity first',
      );
    }
  }
}

export async function enqueueDeletionOperation(
  input: NewDeletionOperation,
): Promise<{ operationId: string; status: 'queued' }> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.clientRequestId)) {
    throw new DeletionConflictError(
      'clientRequestId must be a non-empty string of at most 128 characters',
      400,
    );
  }
  if (input.targets.length === 0) {
    throw new DeletionConflictError('no deletion targets were found', 404);
  }
  const hash = await requestHash(input.payload);
  const operationId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const id = withTransaction((client) => {
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
      return repeated[0];
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
    return operationId;
  });
  wakeDeletionWorker();
  return { operationId: id, status: 'queued' };
}

function claimTarget(): DeletionWorkTarget | null {
  return withTransaction((client) => {
    const now = Math.floor(Date.now() / 1000);
    const row = client.prepare(
      `SELECT t.id, t.operation_id, o.server_id, t.target_kind, t.target_key, t.snapshot, t.logical_size
       FROM deletion_targets t JOIN deletion_operations o ON o.id = t.operation_id
       WHERE t.status = 'queued' OR (t.status = 'waiting_retry' AND t.next_retry_at <= ?)
       ORDER BY o.created_at, t.ordinal LIMIT 1`,
    ).value<[number, string, number, DeletionKind, string, string, number | null]>(now);
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
    const permanent = error instanceof DeletionValidationError;
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
      'SELECT id, client_request_id, library_key, kind, status, target_count, completed_count, failed_count, logical_size_removed, next_retry_at, created_at, started_at, finished_at, updated_at FROM deletion_operations WHERE id = ? AND server_id = ?',
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
      'SELECT id, ordinal, target_kind, target_key, title, status, attempt_count, next_retry_at, error, logical_size FROM deletion_targets WHERE operation_id = ? ORDER BY ordinal',
    ).values(id).map((target) =>
      Object.fromEntries([
        'id',
        'ordinal',
        'targetKind',
        'targetKey',
        'title',
        'status',
        'attemptCount',
        'nextRetryAt',
        'error',
        'logicalSize',
      ].map((key, index) => [key, target[index]]))
    );
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

export function retryDeletionOperation(id: string, serverId: number): boolean {
  return withTransaction((client) => {
    const now = Math.floor(Date.now() / 1000);
    const operation = client.prepare(
      "SELECT library_key FROM deletion_operations WHERE id = ? AND server_id = ? AND status = 'needs_attention'",
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
    client.prepare(
      "UPDATE deletion_targets SET status = 'queued', attempt_count = 0, next_retry_at = NULL, error = NULL, updated_at = ? WHERE operation_id = ? AND status = 'needs_attention'",
    ).run(now, id);
    client.prepare(
      "UPDATE deletion_operations SET status = 'queued', failed_count = 0, next_retry_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?",
    ).run(now, id);
    return true;
  });
}
