import { CURRENT_LOCATION_POLICY_VERSION } from '../../../../../shared/deletionPolicy.ts';
import {
  holdLegacyDeletionTargets,
  UPGRADE_HOLD,
  UPGRADE_RECOVERY_MESSAGE,
} from './upgradePolicy.ts';
import type { SqliteClient } from '../../../db/index.ts';

interface RecoveryStatement {
  run(...params: unknown[]): unknown;
}

interface RecoveryClient {
  prepare(sql: string): RecoveryStatement;
}

export function recoverInterruptedDeletionWork(client: RecoveryClient, now: number): void {
  try {
    holdLegacyDeletionTargets(client as SqliteClient, now);
  } catch (error) {
    if (!(error instanceof Error) || !/no such column/i.test(error.message)) throw error;
  }
  // Gate before resetting running work. No legacy snapshot may reach a replay,
  // including callers that invoke restart recovery independently of the worker.
  try {
    client.prepare(
      `UPDATE deletion_targets SET status = 'needs_attention', next_retry_at = NULL,
       snapshot = CASE WHEN json_valid(snapshot) THEN json_set(snapshot, '$.upgradeHold', ?, '$.upgradePreviousError', error) ELSE snapshot END,
       error = ?, updated_at = ?
       WHERE status NOT IN ('completed', 'cancelled')
         AND NOT (status = 'completed_with_warning' AND phase = 'finalizing')
         AND CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.upgradeHold') IS NULL ELSE 1 END
         AND CASE WHEN json_valid(snapshot) THEN COALESCE(json_extract(snapshot, '$.currentLocationPolicyVersion'), -1) <> ? ELSE 1 END`,
    ).run(UPGRADE_HOLD, UPGRADE_RECOVERY_MESSAGE, now, CURRENT_LOCATION_POLICY_VERSION);
    client.prepare(
      `UPDATE deletion_operations SET status = 'needs_attention', next_retry_at = NULL, updated_at = ?
       WHERE id IN (SELECT operation_id FROM deletion_targets WHERE status = 'needs_attention'
         AND CASE WHEN json_valid(snapshot) THEN json_extract(snapshot, '$.upgradeHold') = ? ELSE 1 END)`,
    ).run(now, UPGRADE_HOLD);
  } catch (error) {
    // Pre-snapshot schemas cannot execute durable work; current migrated databases
    // always contain these columns. Keep the small migration recovery fixtures usable.
    if (!(error instanceof Error) || !/no such column/i.test(error.message)) throw error;
  }
  try {
    client.prepare(
      `UPDATE deletion_targets SET status = 'needs_attention', next_retry_at = NULL,
         error = 'abandoned season-coordinator targets cannot be resumed; reset the development database or review and dismiss this operation',
         updated_at = ?
       WHERE target_kind = 'sonarr_series' AND status NOT IN ('completed','completed_with_warning','cancelled')`,
    ).run(now);
  } catch (error) {
    if (!(error instanceof Error) || !/no such column/i.test(error.message)) throw error;
  }
  try {
    client.prepare(
      `DELETE FROM radarr_movie_reservations
       WHERE target_id IN (SELECT id FROM deletion_targets WHERE status IN ('completed','cancelled'))`,
    ).run();
  } catch (error) {
    // Compatibility for recovery tests and interrupted upgrades whose pre-0047
    // schema has not yet acquired feature-specific reservations.
    if (!(error instanceof Error) || !/no such table/i.test(error.message)) throw error;
  }
  client.prepare(
    `UPDATE deletion_targets
     SET status = 'queued',
         next_retry_at = NULL,
         updated_at = ?
     WHERE status = 'running'`,
  ).run(now);
  client.prepare(
    "UPDATE deletion_operations SET status = 'queued', next_retry_at = NULL, updated_at = ? WHERE status = 'running'",
  ).run(now);
  try {
    client.prepare(
      `UPDATE deletion_operations
       SET status = 'needs_attention', next_retry_at = NULL, updated_at = ?
       WHERE id IN (
         SELECT operation_id FROM deletion_targets
         WHERE target_kind = 'sonarr_series' AND status = 'needs_attention'
       )`,
    ).run(now);
  } catch (error) {
    if (!(error instanceof Error) || !/no such column/i.test(error.message)) throw error;
  }
  try {
    client.prepare(
      `UPDATE radarr_movie_reservations
       SET state = 'reserved', updated_at = ?
       WHERE state <> 'management_hold'
         AND target_id IN (
           SELECT id FROM deletion_targets WHERE status IN ('queued','running','waiting_retry')
         )`,
    ).run(now);
  } catch (error) {
    if (!(error instanceof Error) || !/no such table/i.test(error.message)) throw error;
  }
}
