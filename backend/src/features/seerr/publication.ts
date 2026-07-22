import type { SqliteClient } from '../../db/index.ts';

export function publishStagedRequestGeneration(
  client: SqliteClient,
  instanceId: number,
  syncMarker: number,
  syncedAt: number,
  previousSyncedAt: number | null,
): void {
  client.prepare(
    `INSERT INTO seerr_requests
       (server_id, seerr_instance_id, request_id, account_id, requester_username,
        requester_email, rating_key, media_type, request_status, media_status,
        requested_at, available_at, availability_observed_at,
        availability_observed_sync_at, availability_estimated, synced_at)
     SELECT server_id, seerr_instance_id, request_id, account_id, requester_username,
        requester_email, rating_key, media_type, request_status, media_status,
        requested_at, available_at, availability_observed_at,
        availability_observed_sync_at, availability_estimated, sync_marker
     FROM seerr_request_sync_stage
     WHERE seerr_instance_id = ? AND sync_marker = ?
     ON CONFLICT(seerr_instance_id, request_id) DO UPDATE SET
       account_id = excluded.account_id,
       requester_username = excluded.requester_username,
       requester_email = excluded.requester_email,
       rating_key = excluded.rating_key,
       media_type = excluded.media_type,
       request_status = excluded.request_status,
       media_status = excluded.media_status,
       requested_at = excluded.requested_at,
       available_at = excluded.available_at,
       availability_observed_at = excluded.availability_observed_at,
       availability_observed_sync_at = excluded.availability_observed_sync_at,
       availability_estimated = excluded.availability_estimated,
       synced_at = excluded.synced_at`,
  ).run(instanceId, syncMarker);
  client.prepare(
    `DELETE FROM seerr_request_seasons
     WHERE seerr_instance_id = ? AND request_id IN (
       SELECT request_id FROM seerr_request_sync_stage
       WHERE seerr_instance_id = ? AND sync_marker = ?
     )`,
  ).run(instanceId, instanceId, syncMarker);
  client.prepare(
    `INSERT INTO seerr_request_seasons (seerr_instance_id, request_id, season_number)
     SELECT seerr_instance_id, request_id, season_number
     FROM seerr_request_season_sync_stage
     WHERE seerr_instance_id = ? AND sync_marker = ?`,
  ).run(instanceId, syncMarker);
  // Requests that disappeared before confirmation have no historical fact to retain.
  // Confirmed rows remain available to the rolling assessment even after Seerr cleanup.
  client.prepare(
    `DELETE FROM seerr_requests
     WHERE seerr_instance_id = ? AND synced_at <> ? AND available_at IS NULL`,
  ).run(instanceId, syncMarker);
  client.prepare(
    `UPDATE seerr_requests SET synced_at = ?
     WHERE seerr_instance_id = ? AND synced_at = ?`,
  ).run(syncedAt, instanceId, syncMarker);
  // Successful timestamps are stored at second precision. If two generations finish
  // in the same second, a brand-new observation has the same value as the previous
  // marker and is indistinguishable here from carried evidence. Defer all promotion in
  // that narrow case so one generation can never confirm itself.
  if (previousSyncedAt !== null && previousSyncedAt !== syncedAt) {
    client.prepare(
      `UPDATE seerr_requests
       SET available_at = availability_observed_at,
           availability_observed_at = NULL,
           availability_observed_sync_at = NULL
       WHERE seerr_instance_id = ?
         AND synced_at = ?
         AND available_at IS NULL
         AND availability_observed_at IS NOT NULL
         AND availability_observed_sync_at = ?`,
    ).run(instanceId, syncedAt, previousSyncedAt);
  }
  client.prepare(
    `UPDATE seerr_instances
     SET requests_synced_at = ?, requests_sync_error = NULL
     WHERE id = ?`,
  ).run(syncedAt, instanceId);
  client.prepare(
    `DELETE FROM seerr_request_sync_stage
     WHERE seerr_instance_id = ? AND sync_marker = ?`,
  ).run(instanceId, syncMarker);
}
