import type { SqliteClient } from '../../db/index.ts';
import { mappingRequiresActivityInvalidation } from './userIdentity.ts';

export interface ConfirmedMappingUpdate {
  accountId: number;
  previous: number | null | undefined;
  next: number | null;
}

export function applyConfirmedIdentityMappings(
  client: SqliteClient,
  serverId: number,
  mappings: ConfirmedMappingUpdate[],
): void {
  const resetUser = client.prepare(
    `UPDATE users SET
       last_viewed_at = NULL,
       last_ip = NULL,
       last_player = NULL,
       total_plays = 0,
       total_duration = 0,
       last_scrobbled_at = NULL
     WHERE server_id = ? AND account_id = ?`,
  );
  const deleteItemActivity = client.prepare(
    'DELETE FROM user_item_activity WHERE server_id = ? AND account_id = ?',
  );
  const deleteSeasonActivity = client.prepare(
    'DELETE FROM user_season_activity WHERE server_id = ? AND account_id = ?',
  );
  const deleteIpHistory = client.prepare(
    'DELETE FROM user_ip_history WHERE server_id = ? AND account_id = ?',
  );
  const deleteObservations = client.prepare(
    'DELETE FROM user_play_observations WHERE server_id = ? AND account_id = ?',
  );
  const updateMapping = client.prepare(
    'UPDATE users SET local_account_id = ? WHERE server_id = ? AND account_id = ?',
  );

  for (const mapping of mappings) {
    if (mappingRequiresActivityInvalidation(mapping.previous, mapping.next)) {
      resetUser.run(serverId, mapping.accountId);
      deleteItemActivity.run(serverId, mapping.accountId);
      deleteSeasonActivity.run(serverId, mapping.accountId);
      deleteIpHistory.run(serverId, mapping.accountId);
      deleteObservations.run(serverId, mapping.accountId);
    }
    updateMapping.run(mapping.next, serverId, mapping.accountId);
  }

  resetUser.finalize();
  deleteItemActivity.finalize();
  deleteSeasonActivity.finalize();
  deleteIpHistory.finalize();
  deleteObservations.finalize();
  updateMapping.finalize();
}
