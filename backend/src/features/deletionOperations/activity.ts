import { withTransaction } from '../../db/index.ts';
import type {
  DeletionActivityResponse,
  DeletionOperationStatus,
} from '../../../../shared/types.ts';

/** Read durable state directly: acceptance, retries and reloads need no event emission. */
export function deletionActivity(
  serverId: number,
  limit: number,
  offset: number,
): DeletionActivityResponse {
  return withTransaction((client) => {
    const rows = client.prepare(`
      SELECT id, status, target_count, created_at, updated_at
      FROM deletion_operations WHERE server_id = ?
      ORDER BY CASE WHEN status IN ('queued', 'running', 'waiting_retry') THEN 0
                    WHEN status = 'needs_attention' THEN 1 ELSE 2 END,
               updated_at DESC, created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).values<[string, DeletionOperationStatus, number, number, number]>(
      serverId,
      limit + 1,
      offset,
    );
    return {
      limit,
      offset,
      hasMore: rows.length > limit,
      operations: rows.slice(0, limit).map(([id, status, targetCount, createdAt, updatedAt]) => ({
        id,
        status,
        targetCount,
        createdAt,
        updatedAt,
        // Read at most three titles, even for a season operation with thousands of targets.
        titles: [
          ...new Set(
            client.prepare(
              'SELECT title FROM deletion_targets WHERE operation_id = ? ORDER BY ordinal LIMIT 3',
            ).values<[string]>(id).map(([title]) => title),
          ),
        ],
        waitingForServiceVerification: ['queued', 'running', 'waiting_retry'].includes(status) &&
          client.prepare(`SELECT 1 FROM deletion_targets WHERE operation_id = ?
            AND status = 'waiting_retry'
            AND (json_type(CASE WHEN json_valid(snapshot) THEN snapshot ELSE '{}' END, '$.serviceOwnedPlan') = 'object'
              OR json_type(CASE WHEN json_valid(snapshot) THEN snapshot ELSE '{}' END, '$.ordinaryPlan') = 'object')
            LIMIT 1`).value(id) !== undefined,
      })),
    };
  });
}
