interface RecoveryStatement {
  run(...params: unknown[]): unknown;
}

interface RecoveryClient {
  prepare(sql: string): RecoveryStatement;
}

export function recoverInterruptedDeletionWork(client: RecoveryClient, now: number): void {
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
}
