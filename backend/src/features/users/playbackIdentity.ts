import type { SqliteClient } from '../../db/index.ts';

export type PlaybackIdentityResult = number | 'unmatched' | 'ambiguous';

// Must be called inside the same native transaction as the resulting activity write.
// That makes a confirmed mapping change serialize wholly before or wholly after the
// observation instead of allowing resolution through a mapping that was just cleared.
export function resolvePlaybackAccountId(
  client: SqliteClient,
  serverId: number,
  plexAccountId: number | null,
  kind: 'local' | 'session',
): PlaybackIdentityResult {
  if (
    plexAccountId === null || !Number.isSafeInteger(plexAccountId) || plexAccountId <= 0
  ) {
    return 'unmatched';
  }

  const statement = client.prepare(
    kind === 'session'
      ? `SELECT account_id FROM users
         WHERE server_id = ? AND (account_id = ? OR local_account_id = ?)`
      : `SELECT account_id FROM users
         WHERE server_id = ? AND local_account_id = ?`,
  );
  const rows = kind === 'session'
    ? statement.values(serverId, plexAccountId, plexAccountId)
    : statement.values(serverId, plexAccountId);
  statement.finalize();

  const accountIds = [...new Set(rows.map((row) => Number(row[0])))];
  return accountIds.length === 0
    ? 'unmatched'
    : accountIds.length === 1
    ? accountIds[0]
    : 'ambiguous';
}
