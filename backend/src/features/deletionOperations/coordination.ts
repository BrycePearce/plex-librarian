import type { SqliteClient } from '../../db/index.ts';
import {
  blockingGuidanceLibraryKeys,
  hasBlockingRelocationGuidance,
  incompleteBarrierLibraryKeys,
} from './relocation.ts';

interface CoordinationStatement {
  value<T extends unknown[]>(...params: unknown[]): T | undefined;
  values<T extends unknown[]>(...params: unknown[]): T[];
  run(...params: unknown[]): unknown;
}

interface CoordinationClient {
  prepare(sql: string): CoordinationStatement;
}

const ACTIVE_DELETION_STATUSES = "('queued','running','waiting_retry')";

export function activeServerMatches(
  client: CoordinationClient,
  expectedServerId: number,
): boolean {
  return client.prepare('SELECT active_server_id FROM settings WHERE id = 1').value<
    [number | null]
  >()?.[0] === expectedServerId;
}

// A needs-attention target is terminal for worker scheduling, but it is not finalized:
// its normal projection (and any media-version reservation) must remain available for
// manual replay. Sync may still refresh the library, but its prune phase must not remove
// those durable recovery inputs in a separate transaction. A superseded relocation
// barrier deliberately does not qualify: its targeted sync must be allowed to prune in
// order to complete the barrier. Library-row retention for that barrier is handled below.
export function deletionRecoveryNeedsProjection(
  client: SqliteClient,
  serverId: number,
  libraryKey: string,
): boolean {
  const operationNeedsProjection = client.prepare(
    "SELECT 1 FROM deletion_operations WHERE server_id = ? AND library_key = ? AND status = 'needs_attention' LIMIT 1",
  ).value<[number]>(serverId, libraryKey) !== undefined;
  return operationNeedsProjection ||
    hasBlockingRelocationGuidance(client, serverId, libraryKey);
}

export function deletionRecoveryLibraryKeys(
  client: SqliteClient,
  serverId: number,
): string[] {
  const keys = client.prepare(
    `SELECT DISTINCT o.library_key FROM deletion_operations o
     WHERE o.server_id = ? AND o.status = 'needs_attention'`,
  ).values<[string]>(serverId).map(([libraryKey]) => libraryKey);
  return [
    ...new Set([
      ...keys,
      ...blockingGuidanceLibraryKeys(client, serverId),
      ...incompleteBarrierLibraryKeys(client, serverId),
    ]),
  ];
}

// Must be called inside the same SQLite transaction that changes settings.activeServerId.
// Together with enqueue's activeServerMatches() check, SQLite serialization closes both
// orderings of the accept-vs-switch race: either the operation lands first and blocks the
// switch, or the switch lands first and causes acceptance for the old server to fail.
export function setActiveServerIfDeletionIdle(
  client: CoordinationClient,
  nextServerId: number | null,
): boolean {
  const currentServerId = client.prepare(
    'SELECT active_server_id FROM settings WHERE id = 1',
  ).value<[number | null]>()?.[0] ?? null;
  if (currentServerId !== nextServerId) {
    const activeDeletion = client.prepare(
      `SELECT COUNT(DISTINCT server_id), MIN(server_id) FROM deletion_operations WHERE status IN ${ACTIVE_DELETION_STATUSES}`,
    ).value<[number, number | null]>() ?? [0, null];
    // A revoked token may have cleared the active pointer while durable work remains.
    // Reconnecting that same server restores the worker's recovery path; changing to a
    // different server or disconnecting still waits for the operation to become terminal.
    if (
      activeDeletion[0] > 0 &&
      !(currentServerId === null && activeDeletion[0] === 1 && activeDeletion[1] === nextServerId)
    ) {
      return false;
    }
  }
  client.prepare('UPDATE settings SET active_server_id = ? WHERE id = 1').run(nextServerId);
  return true;
}
