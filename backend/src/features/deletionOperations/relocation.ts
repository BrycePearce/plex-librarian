import type { SqliteClient } from '../../db/index.ts';
import { withTransaction } from '../../db/index.ts';
import { activeLibraryOperation } from '../../services/libraryOperations.ts';
import { refreshDeletionOperation } from './state.ts';
import {
  assertOnlyRelocationDelta,
  canonicalJson,
  RELOCATION_SUPERSEDED_REASON,
  type RelocationGuidance,
  relocationReservationKind,
  relocationSupersededPredicateSql,
  type RelocationSyncBarrier,
  type RelocationTargetIdentity,
  validateRelocationBarrier,
  validateRelocationGuidance,
  workflowKeyPresent,
} from './relocationModel.ts';

export {
  canonicalJson,
  relocationSupersededPredicateSql,
  workflowKeyPresent,
} from './relocationModel.ts';

export class RelocationConflictError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    canonicalJson(parsed);
    return parsed as Record<string, unknown>;
  } catch {
    throw new RelocationConflictError('The deletion snapshot is invalid');
  }
}

function arrIntentAbsent(snapshot: Record<string, unknown>): boolean {
  return !workflowKeyPresent(snapshot, 'arrReassignments') ||
    (Array.isArray(snapshot.arrReassignments) && snapshot.arrReassignments.length === 0);
}

function removalTargetKind(kind: string): string {
  return kind === 'whole_item' ? 'item' : kind;
}

export interface RelocationLifecycleRow {
  targetId: number;
  operationId: string;
  serverId: number;
  targetKind: 'whole_item' | 'movie_version' | 'episode_version';
  targetKey: string;
  status: string;
  phase: string;
  plexAttemptCount: number;
  removalConfirmedAt: number | null;
  error: string | null;
  snapshot: Record<string, unknown>;
}

export type RelocationGuidanceState = 'none' | 'valid' | 'invalid';
export type RelocationBarrierState = 'none' | 'incomplete' | 'completed' | 'invalid';

export interface RelocationLifecycleClassification {
  guidanceState: RelocationGuidanceState;
  barrierState: RelocationBarrierState;
  guidance?: RelocationGuidance;
  barrier?: RelocationSyncBarrier;
  placement: 'none' | 'active' | 'superseded' | 'invalid';
}

type RelocationReservation = [number, string, number, string, string, number];

export interface RelocationLifecycleEvidence {
  removalEvidencePresent: boolean;
  reservations: RelocationReservation[];
}

function removalEvidenceKey(
  row: Pick<RelocationLifecycleRow, 'operationId' | 'targetKind' | 'targetKey'>,
): string {
  return `${row.operationId}\0${removalTargetKind(row.targetKind)}\0${row.targetKey}`;
}

function batches<T>(values: readonly T[], size = 400): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export function loadRelocationLifecycleEvidence(
  client: SqliteClient,
  rows: readonly RelocationLifecycleRow[],
): Map<number, RelocationLifecycleEvidence> {
  const result = new Map<number, RelocationLifecycleEvidence>();
  const targetIdsByRemovalKey = new Map<string, number[]>();
  for (const row of rows) {
    result.set(row.targetId, { removalEvidencePresent: false, reservations: [] });
    const key = removalEvidenceKey(row);
    targetIdsByRemovalKey.set(key, [...(targetIdsByRemovalKey.get(key) ?? []), row.targetId]);
  }
  const operationIds = [...new Set(rows.map((row) => row.operationId))];
  for (const operationBatch of batches(operationIds)) {
    if (operationBatch.length === 0) continue;
    const removals = client.prepare(
      `SELECT operation_id,target_kind,target_key FROM media_removals
       WHERE operation_id IN (${operationBatch.map(() => '?').join(',')})`,
    ).values<[string, string, string]>(...operationBatch);
    for (const [operationId, targetKind, targetKey] of removals) {
      const key = `${operationId}\0${targetKind}\0${targetKey}`;
      for (const targetId of targetIdsByRemovalKey.get(key) ?? []) {
        result.get(targetId)!.removalEvidencePresent = true;
      }
    }
  }
  for (const targetBatch of batches([...result.keys()])) {
    if (targetBatch.length === 0) continue;
    const reservations = client.prepare(
      `SELECT server_id,media_kind,media_id,rating_key,operation_id,target_id
       FROM media_version_reservations
       WHERE target_id IN (${targetBatch.map(() => '?').join(',')})`,
    ).values<RelocationReservation>(...targetBatch);
    for (const reservation of reservations) {
      result.get(reservation[5])?.reservations.push(reservation);
    }
  }
  return result;
}

export function classifyRelocationLifecycle(
  row: RelocationLifecycleRow,
  evidence: RelocationLifecycleEvidence,
): RelocationLifecycleClassification {
  const guidancePresent = workflowKeyPresent(row.snapshot, 'relocationGuidance');
  const barrierPresent = workflowKeyPresent(row.snapshot, 'relocationSyncBarrier');
  if (!guidancePresent && !barrierPresent) {
    return { guidanceState: 'none', barrierState: 'none', placement: 'none' };
  }
  const identity: RelocationTargetIdentity = { targetKind: row.targetKind, ...row.snapshot };
  const guidance = guidancePresent
    ? validateRelocationGuidance(row.snapshot.relocationGuidance, identity)
    : null;
  const barrier = barrierPresent
    ? validateRelocationBarrier(row.snapshot.relocationSyncBarrier)
    : null;
  const milestones = row.phase === 'validating' && row.plexAttemptCount === 0 &&
    row.removalConfirmedAt === null && !evidence.removalEvidencePresent &&
    arrIntentAbsent(row.snapshot);
  let active = false;
  let superseded = false;
  if (guidance && milestones) {
    const reservations = evidence.reservations;
    active = !barrierPresent && row.status === 'needs_attention' && reservations.length === 1 &&
      reservations[0]![0] === row.serverId &&
      reservations[0]![1] === relocationReservationKind(guidance) &&
      reservations[0]![2] === guidance.selectedMediaId &&
      reservations[0]![3] === row.snapshot.ratingKey &&
      reservations[0]![4] === row.operationId && reservations[0]![5] === row.targetId;
    superseded = barrierPresent && row.status === 'cancelled' &&
      row.error === RELOCATION_SUPERSEDED_REASON && reservations.length === 0;
  }
  const placement = active ? 'active' : superseded ? 'superseded' : 'invalid';
  const coherentBarrier = guidance && barrier && superseded &&
    barrier.guidanceId === guidance.guidanceId && barrier.supersededAt >= guidance.observedAt;
  return {
    guidanceState: guidance && (active || superseded)
      ? 'valid'
      : guidancePresent
      ? 'invalid'
      : 'none',
    barrierState: coherentBarrier
      ? barrier.finishedAt === undefined ? 'incomplete' : 'completed'
      : barrierPresent
      ? 'invalid'
      : 'none',
    ...(guidance && (active || superseded) ? { guidance: { ...guidance } } : {}),
    ...(coherentBarrier ? { barrier: { ...barrier } } : {}),
    placement,
  };
}

const PRESENT_SQL = "json_type(snapshot, '$.%KEY%') IS NOT NULL";
function presentSql(key: 'relocationGuidance' | 'relocationSyncBarrier'): string {
  return PRESENT_SQL.replace('%KEY%', key);
}

export function hasIncompleteRelocationBarrier(
  client: SqliteClient,
  serverId: number,
  libraryKey: string,
): boolean {
  const rows = client.prepare(
    `SELECT t.id,t.operation_id,o.server_id,t.target_kind,t.target_key,t.status,t.phase,
            t.plex_attempt_count,t.removal_confirmed_at,t.error,t.snapshot
     FROM deletion_targets t JOIN deletion_operations o ON o.id=t.operation_id
     WHERE o.server_id=? AND o.library_key=? AND ${presentSql('relocationSyncBarrier')}`,
  ).values<
    [
      number,
      string,
      number,
      RelocationLifecycleRow['targetKind'],
      string,
      string,
      string,
      number,
      number | null,
      string | null,
      string,
    ]
  >(serverId, libraryKey);
  const lifecycleRows: RelocationLifecycleRow[] = [];
  for (const value of rows) {
    try {
      lifecycleRows.push({
        targetId: value[0],
        operationId: value[1],
        serverId: value[2],
        targetKind: value[3],
        targetKey: value[4],
        status: value[5],
        phase: value[6],
        plexAttemptCount: value[7],
        removalConfirmedAt: value[8],
        error: value[9],
        snapshot: parseObject(value[10]),
      });
    } catch {
      return true;
    }
  }
  const evidence = loadRelocationLifecycleEvidence(client, lifecycleRows);
  return lifecycleRows.some((row) =>
    classifyRelocationLifecycle(row, evidence.get(row.targetId)!).barrierState !==
      'completed'
  );
}

export function assertRelocationBarrierClear(serverId: number, libraryKey: string): void {
  if (withTransaction((client) => hasIncompleteRelocationBarrier(client, serverId, libraryKey))) {
    throw new RelocationConflictError(
      'A targeted library sync is required to finish retained-version relocation before cleanup can continue',
    );
  }
}

export function hasBlockingRelocationGuidance(
  client: SqliteClient,
  serverId: number,
  libraryKey: string,
  projectionRoots: readonly string[] = [],
): boolean {
  const roots = [...new Set(projectionRoots)];
  const rootPredicate = roots.length === 0
    ? ''
    : ` AND COALESCE(json_extract(t.snapshot, '$.showRatingKey'), json_extract(t.snapshot, '$.ratingKey')) IN (${
      roots.map(() => '?').join(',')
    })`;
  return client.prepare(
    `SELECT 1 FROM deletion_targets t JOIN deletion_operations o ON o.id=t.operation_id
     WHERE o.server_id=? AND o.library_key=?
       AND ${presentSql('relocationGuidance')}
       AND NOT ${presentSql('relocationSyncBarrier')}${rootPredicate}
     LIMIT 1`,
  ).value(serverId, libraryKey, ...roots) !== undefined;
}

export function assertRelocationWorkflowClear(
  serverId: number,
  libraryKey: string,
  projectionRoots: readonly string[] = [],
): void {
  const state = withTransaction((client) => ({
    barrierBlocked: hasIncompleteRelocationBarrier(client, serverId, libraryKey),
    guidanceBlocked: hasBlockingRelocationGuidance(
      client,
      serverId,
      libraryKey,
      projectionRoots,
    ),
  }));
  if (state.barrierBlocked) {
    throw new RelocationConflictError(
      'A targeted library sync is required to finish retained-version relocation before cleanup can continue',
    );
  }
  if (state.guidanceBlocked) {
    throw new RelocationConflictError(
      'Retained-version relocation guidance must be resolved before cleanup can continue',
    );
  }
}

export function hasAnyIncompleteRelocationBarrier(serverId: number): boolean {
  return withTransaction((client) =>
    client.prepare(
      `SELECT DISTINCT o.library_key FROM deletion_targets t JOIN deletion_operations o ON o.id=t.operation_id
     WHERE o.server_id=? AND ${presentSql('relocationSyncBarrier')}`,
    ).values<[string]>(serverId).some(([key]) =>
      hasIncompleteRelocationBarrier(client, serverId, key)
    )
  );
}

export interface FinishRelocationResult {
  targetId: number;
  guidanceId: string;
  libraryKey: string;
  barrier: RelocationSyncBarrier;
  syncDeferred: boolean;
  repeated: boolean;
}

function lifecycleRow(
  client: SqliteClient,
  operationId: string,
  targetId: number,
  serverId: number,
) {
  const row = client.prepare(
    `SELECT t.id, t.operation_id, o.server_id, t.target_kind, t.target_key, t.status, t.phase,
            t.plex_attempt_count, t.removal_confirmed_at, t.error, t.snapshot, o.library_key
     FROM deletion_targets t JOIN deletion_operations o ON o.id=t.operation_id
     WHERE t.id=? AND t.operation_id=? AND o.server_id=?`,
  ).value<
    [
      number,
      string,
      number,
      RelocationLifecycleRow['targetKind'],
      string,
      string,
      string,
      number,
      number | null,
      string | null,
      string,
      string,
    ]
  >(targetId, operationId, serverId);
  if (!row) return null;
  return {
    lifecycle: {
      targetId: row[0],
      operationId: row[1],
      serverId: row[2],
      targetKind: row[3],
      targetKey: row[4],
      status: row[5],
      phase: row[6],
      plexAttemptCount: row[7],
      removalConfirmedAt: row[8],
      error: row[9],
      snapshot: parseObject(row[10]),
    } satisfies RelocationLifecycleRow,
    raw: row[10],
    libraryKey: row[11],
  };
}

function recoveryTargetsRemain(
  client: SqliteClient,
  serverId: number,
  libraryKey: string,
): boolean {
  return client.prepare(
    `SELECT 1 FROM deletion_targets t JOIN deletion_operations o ON o.id=t.operation_id
     WHERE o.server_id=? AND o.library_key=? AND t.status='needs_attention' LIMIT 1`,
  ).value<[number]>(serverId, libraryKey) !== undefined;
}

export function finishRelocation(
  operationId: string,
  targetId: number,
  serverId: number,
  guidanceId: string,
  destinationPlaybackConfirmed: boolean,
): FinishRelocationResult {
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    throw new RelocationConflictError('Relocation target not found', 404);
  }
  if (!destinationPlaybackConfirmed) {
    throw new RelocationConflictError(
      'Confirm that the Plex version with the exact destination Part path played successfully',
      400,
    );
  }
  const operation = withTransaction((client) =>
    client.prepare(
      'SELECT library_key FROM deletion_operations WHERE id=? AND server_id=?',
    ).value<[string]>(operationId, serverId)
  );
  if (!operation) throw new RelocationConflictError('Deletion operation not found', 404);
  if (activeLibraryOperation(serverId, operation[0]) !== null) {
    throw new RelocationConflictError('This library is currently syncing or being modified');
  }
  return withTransaction((client) => {
    const loaded = lifecycleRow(client, operationId, targetId, serverId);
    if (!loaded) throw new RelocationConflictError('Relocation target not found', 404);
    const current = classifyRelocationLifecycle(
      loaded.lifecycle,
      loadRelocationLifecycleEvidence(client, [loaded.lifecycle]).get(targetId)!,
    );
    if (current.guidance?.guidanceId !== guidanceId) {
      const rawGuidance = validateRelocationGuidance(
        loaded.lifecycle.snapshot.relocationGuidance,
        { targetKind: loaded.lifecycle.targetKind, ...loaded.lifecycle.snapshot },
      );
      if (rawGuidance?.guidanceId === guidanceId) {
        throw new RelocationConflictError('The original deletion target is no longer untouched');
      }
      throw new RelocationConflictError('Relocation guidance no longer matches this request');
    }
    if (current.placement === 'superseded' && current.barrier) {
      return {
        targetId,
        guidanceId,
        libraryKey: loaded.libraryKey,
        barrier: current.barrier,
        syncDeferred: recoveryTargetsRemain(client, serverId, loaded.libraryKey),
        repeated: true,
      };
    }
    if (current.placement !== 'active' || !current.guidance) {
      throw new RelocationConflictError('The original deletion target is no longer untouched');
    }
    if (
      client.prepare(
        `SELECT 1 FROM deletion_targets t JOIN deletion_operations o ON o.id=t.operation_id
       WHERE o.server_id=? AND o.library_key=? AND t.id<>?
         AND t.status IN ('queued','running','waiting_retry') LIMIT 1`,
      ).value(serverId, loaded.libraryKey, targetId)
    ) {
      throw new RelocationConflictError('This library still has active deletion work');
    }
    if (
      client.prepare(
        "SELECT 1 FROM sync_log WHERE server_id=? AND status='pending' AND (library_key IS NULL OR library_key=?) LIMIT 1",
      ).value(serverId, loaded.libraryKey)
    ) throw new RelocationConflictError('This library is currently syncing');
    const ratingKey = loaded.lifecycle.snapshot.ratingKey;
    if (typeof ratingKey !== 'string') {
      throw new RelocationConflictError('The deletion snapshot is invalid');
    }
    if (
      client.prepare(
        `SELECT 1 FROM deletion_targets t JOIN deletion_operations o ON o.id=t.operation_id
       WHERE o.server_id=? AND o.library_key=? AND t.id<>?
         AND t.status NOT IN ('completed','completed_with_warning','cancelled')
         AND (json_extract(t.snapshot,'$.ratingKey')=? OR json_extract(t.snapshot,'$.showRatingKey')=?) LIMIT 1`,
      ).value(serverId, loaded.libraryKey, targetId, ratingKey, ratingKey)
    ) {
      throw new RelocationConflictError('Another unresolved target overlaps this movie');
    }
    const now = Math.floor(Date.now() / 1000);
    const barrier: RelocationSyncBarrier = { guidanceId, supersededAt: now };
    const after = { ...loaded.lifecycle.snapshot, relocationSyncBarrier: barrier };
    try {
      assertOnlyRelocationDelta(loaded.lifecycle.snapshot, after);
    } catch (error) {
      throw new RelocationConflictError(
        error instanceof Error ? error.message : 'Invalid snapshot',
      );
    }
    const updated = client.prepare(
      `UPDATE deletion_targets SET snapshot=?, status='cancelled', error=?, next_retry_at=NULL, updated_at=?
       WHERE id=? AND operation_id=? AND snapshot=? AND status='needs_attention' AND phase='validating'
         AND plex_attempt_count=0 AND removal_confirmed_at IS NULL RETURNING id`,
    ).value<[number]>(
      JSON.stringify(after),
      RELOCATION_SUPERSEDED_REASON,
      now,
      targetId,
      operationId,
      loaded.raw,
    );
    if (!updated) throw new RelocationConflictError('Relocation supersede lost a concurrency race');
    client.prepare('DELETE FROM media_version_reservations WHERE target_id=?').run(targetId);
    const nextLoaded = lifecycleRow(client, operationId, targetId, serverId)!;
    const next = classifyRelocationLifecycle(
      nextLoaded.lifecycle,
      loadRelocationLifecycleEvidence(client, [nextLoaded.lifecycle]).get(targetId)!,
    );
    if (next.placement !== 'superseded' || next.barrierState !== 'incomplete' || !next.barrier) {
      throw new RelocationConflictError('Relocation supersede produced invalid durable state');
    }
    refreshDeletionOperation(client, operationId);
    refreshDeletionEvents(client, serverId, operationId);
    return {
      targetId,
      guidanceId,
      libraryKey: loaded.libraryKey,
      barrier: next.barrier,
      syncDeferred: recoveryTargetsRemain(client, serverId, loaded.libraryKey),
      repeated: false,
    };
  });
}

function refreshDeletionEvents(client: SqliteClient, serverId: number, operationId: string): void {
  const operation = client.prepare(
    'SELECT status,target_count,completed_count,warning_count,removal_confirmed_count,failed_count,logical_size_removed,library_key,kind FROM deletion_operations WHERE id=?',
  ).value<[string, number, number, number, number, number, number, string, string]>(operationId);
  if (!operation) return;
  const counts = client.prepare(
    `SELECT COUNT(*) FILTER (WHERE status='cancelled'), COUNT(*) FILTER (WHERE ${relocationSupersededPredicateSql()}) FROM deletion_targets WHERE operation_id=?`,
  ).value<[number, number]>(operationId) ?? [0, 0];
  const payload = JSON.stringify({
    operationId,
    libraryKey: operation[7],
    kind: operation[8],
    status: operation[0],
    targetCount: operation[1],
    completedCount: operation[2],
    warningCount: operation[3],
    removalConfirmedCount: operation[4],
    failedCount: operation[5],
    cancelledCount: counts[0],
    supersededCount: counts[1],
    logicalSizeRemoved: operation[6],
  });
  client.prepare(
    `UPDATE events SET payload=? WHERE server_id=? AND type='deletion.completed' AND json_valid(payload)
       AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.operationId')=? ELSE 0 END`,
  ).run(payload, serverId, operationId);
}

export function incompleteBarrierLibraryKeys(client: SqliteClient, serverId: number): string[] {
  return client.prepare(
    `SELECT DISTINCT o.library_key FROM deletion_targets t JOIN deletion_operations o ON o.id=t.operation_id
     WHERE o.server_id=? AND ${presentSql('relocationSyncBarrier')}`,
  ).values<[string]>(serverId).map(([key]) => key).filter((key) =>
    hasIncompleteRelocationBarrier(client, serverId, key)
  );
}

export function blockingGuidanceLibraryKeys(client: SqliteClient, serverId: number): string[] {
  return client.prepare(
    `SELECT DISTINCT o.library_key FROM deletion_targets t JOIN deletion_operations o ON o.id=t.operation_id
     WHERE o.server_id=? AND ${presentSql('relocationGuidance')}
       AND NOT ${presentSql('relocationSyncBarrier')}`,
  ).values<[string]>(serverId).map(([key]) => key);
}

export function completeRelocationBarriers(
  client: SqliteClient,
  serverId: number,
  libraryKey: string,
  syncId: number,
  startedAt: number,
  finishedAt: number,
): number {
  const rows = client.prepare(
    `SELECT t.id,t.operation_id,o.server_id,t.target_kind,t.target_key,t.status,t.phase,
            t.plex_attempt_count,t.removal_confirmed_at,t.error,t.snapshot
     FROM deletion_targets t JOIN deletion_operations o ON o.id=t.operation_id
     WHERE o.server_id=? AND o.library_key=? AND ${presentSql('relocationSyncBarrier')}`,
  ).values<
    [
      number,
      string,
      number,
      RelocationLifecycleRow['targetKind'],
      string,
      string,
      string,
      number,
      number | null,
      string | null,
      string,
    ]
  >(serverId, libraryKey);
  const parsedRows: Array<{ row: RelocationLifecycleRow; raw: string }> = [];
  for (const value of rows) {
    let snapshot: Record<string, unknown>;
    try {
      snapshot = parseObject(value[10]);
    } catch {
      continue;
    }
    const row: RelocationLifecycleRow = {
      targetId: value[0],
      operationId: value[1],
      serverId: value[2],
      targetKind: value[3],
      targetKey: value[4],
      status: value[5],
      phase: value[6],
      plexAttemptCount: value[7],
      removalConfirmedAt: value[8],
      error: value[9],
      snapshot,
    };
    parsedRows.push({ row, raw: value[10] });
  }
  const evidence = loadRelocationLifecycleEvidence(
    client,
    parsedRows.map(({ row }) => row),
  );
  const completable: Array<
    { row: RelocationLifecycleRow; raw: string; barrier: RelocationSyncBarrier }
  > = [];
  for (const { row, raw } of parsedRows) {
    const state = classifyRelocationLifecycle(row, evidence.get(row.targetId)!);
    if (state.barrierState === 'incomplete' && state.barrier) {
      completable.push({ row, raw, barrier: state.barrier });
    }
  }
  let completed = 0;
  for (const entry of completable) {
    // A sync predating this barrier cannot prove its projection was pruned. Skip only
    // that barrier so an independently eligible older barrier can still complete.
    if (startedAt <= entry.barrier.supersededAt) continue;
    const nextBarrier: RelocationSyncBarrier = { ...entry.barrier, syncId, finishedAt };
    if (!validateRelocationBarrier(nextBarrier)) continue;
    const after = { ...entry.row.snapshot, relocationSyncBarrier: nextBarrier };
    try {
      assertOnlyRelocationDelta(entry.row.snapshot, after);
    } catch {
      continue;
    }
    const updated = client.prepare(
      `UPDATE deletion_targets SET snapshot=?,updated_at=? WHERE id=? AND operation_id=? AND snapshot=?
       RETURNING id`,
    ).value<[number]>(
      JSON.stringify(after),
      finishedAt,
      entry.row.targetId,
      entry.row.operationId,
      entry.raw,
    );
    if (!updated) throw new RelocationConflictError('Relocation barrier lost a concurrency race');
    completed++;
  }
  return completed;
}
