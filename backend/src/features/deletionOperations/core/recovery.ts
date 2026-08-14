interface RecoveryStatement {
  run(...params: unknown[]): unknown;
}

interface RecoveryClient {
  prepare(sql: string): RecoveryStatement;
}

export function recoverInterruptedDeletionWork(client: RecoveryClient, now: number): void {
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
