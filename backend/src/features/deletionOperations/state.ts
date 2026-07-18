import type { SqliteClient } from '../../db/index.ts';

type DeletionKind = 'whole_item' | 'movie_version' | 'episode_version';
type DeletionOperationStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'completed'
  | 'needs_attention'
  | 'cancelled';

export function refreshDeletionOperation(client: SqliteClient, operationId: string): void {
  const now = Math.floor(Date.now() / 1000);
  const operation = client.prepare(
    'SELECT server_id, library_key, kind, status, target_count FROM deletion_operations WHERE id = ?',
  ).value<[number, string, DeletionKind, DeletionOperationStatus, number]>(operationId);
  if (!operation) return;
  const counts = client.prepare(
    "SELECT COUNT(*) FILTER (WHERE status = 'completed'), COUNT(*) FILTER (WHERE status = 'needs_attention'), COUNT(*) FILTER (WHERE status = 'cancelled'), COALESCE(SUM(CASE WHEN status = 'completed' THEN logical_size ELSE 0 END),0), MIN(CASE WHEN status = 'waiting_retry' THEN next_retry_at END), COUNT(*) FILTER (WHERE status = 'running'), COUNT(*) FILTER (WHERE status = 'queued'), COUNT(*) FILTER (WHERE status = 'waiting_retry') FROM deletion_targets WHERE operation_id = ?",
  ).value<[number, number, number, number, number | null, number, number, number]>(operationId);
  if (!counts) return;
  const [completed, failed, cancelled, size, retryAt, running, queued, retrying] = counts;
  const active = running + queued + retrying;
  let status: DeletionOperationStatus;
  let finishedAt: number | null = null;
  if (active > 0) status = running > 0 ? 'running' : queued > 0 ? 'queued' : 'waiting_retry';
  else {
    status = failed > 0
      ? 'needs_attention'
      : completed === 0 && cancelled > 0
      ? 'cancelled'
      : 'completed';
    finishedAt = now;
  }
  client.prepare(
    'UPDATE deletion_operations SET status = ?, completed_count = ?, failed_count = ?, logical_size_removed = ?, next_retry_at = ?, finished_at = ?, updated_at = ? WHERE id = ?',
  ).run(status, completed, failed, size, retryAt, finishedAt, now, operationId);
  if (active === 0 && ['queued', 'running', 'waiting_retry'].includes(operation[3])) {
    client.prepare(
      "INSERT INTO events (server_id, type, payload, created_at) VALUES (?, 'deletion.completed', ?, ?)",
    ).run(
      operation[0],
      JSON.stringify({
        operationId,
        libraryKey: operation[1],
        kind: operation[2],
        status,
        targetCount: operation[4],
        completedCount: completed,
        failedCount: failed,
        cancelledCount: cancelled,
        logicalSizeRemoved: size,
      }),
      now,
    );
  }
}
