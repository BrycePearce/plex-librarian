import { type SqliteClient } from '../../../db/index.ts';

import { persistedRetainedMediaId } from '../arr/arrReassignment.ts';

import {
  DeletionConvergenceError,
  type DeletionWorkTarget,
  PlexReconciliationError,
} from '../core/types.ts';
import { type DurableTargetSnapshot, validateDeletionTarget } from '../core/validation.ts';

export function finalizeTarget(
  client: SqliteClient,
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  attributable: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  const changed = client
    .prepare(
      "UPDATE deletion_targets SET status = 'completed', phase = 'finalizing', removal_confirmed_at = COALESCE(removal_confirmed_at, ?), plex_reconciled_at = ?, next_retry_at = NULL, error = NULL, warning = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND phase = 'plex_reconciliation'",
    )
    .run(now, now, now, target.id);
  if (changed !== 1) throw new DeletionConvergenceError('deletion target state changed');
  let removed = 0;
  if (target.targetKind === 'whole_item') {
    if (snapshot.type === 'season') {
      removed = client
        .prepare('DELETE FROM seasons WHERE server_id = ? AND rating_key = ?')
        .run(target.serverId, snapshot.ratingKey);
      if (removed > 0) {
        client.prepare(
          `UPDATE items SET
             file_size = MAX(0, COALESCE(file_size, 0) - ?),
             duration = MAX(0, COALESCE(duration, 0) - ?)
           WHERE server_id = ? AND rating_key = ? AND type = 'show'`,
        ).run(
          snapshot.fileSize ?? 0,
          snapshot.wholeSeasonDuration ?? 0,
          target.serverId,
          snapshot.showRatingKey!,
        );
      }
    } else {
      removed = client
        .prepare('DELETE FROM items WHERE server_id = ? AND rating_key = ?')
        .run(target.serverId, snapshot.ratingKey);
    }
  } else if (target.targetKind === 'movie_version') {
    removed = client
      .prepare(
        'DELETE FROM item_media_versions WHERE server_id = ? AND item_rating_key = ? AND media_id = ?',
      )
      .run(target.serverId, snapshot.ratingKey, snapshot.mediaId!);
    client
      .prepare(
        'UPDATE items SET file_size = (SELECT SUM(file_size) FROM item_media_versions WHERE server_id = ? AND item_rating_key = ?) WHERE server_id = ? AND rating_key = ?',
      )
      .run(target.serverId, snapshot.ratingKey, target.serverId, snapshot.ratingKey);
  } else {
    removed = client
      .prepare(
        'DELETE FROM episode_media_versions WHERE server_id = ? AND episode_rating_key = ? AND media_id = ?',
      )
      .run(target.serverId, snapshot.ratingKey, snapshot.mediaId!);
    if (removed > 0) {
      const size = snapshot.fileSize ?? 0;
      client
        .prepare(
          'UPDATE seasons SET file_size = MAX(0, COALESCE(file_size, 0) - ?) WHERE server_id = ? AND rating_key = ?',
        )
        .run(size, target.serverId, snapshot.seasonRatingKey!);
      client
        .prepare(
          "UPDATE items SET file_size = MAX(0, COALESCE(file_size, 0) - ?) WHERE server_id = ? AND rating_key = ? AND type = 'show'",
        )
        .run(size, target.serverId, snapshot.showRatingKey!);
    }
  }
  if (attributable) {
    const kind = target.targetKind === 'whole_item' ? 'item' : target.targetKind;
    client.prepare(
      `INSERT INTO media_removals
         (server_id, operation_id, target_kind, target_key, media_size, logical_attributable, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(server_id, operation_id, target_kind, target_key) DO UPDATE SET
         media_size = excluded.media_size, logical_attributable = 1`,
    ).run(target.serverId, target.operationId, kind, target.targetKey, target.logicalSize, now);
  }
  client.prepare('DELETE FROM media_version_reservations WHERE target_id = ?').run(target.id);
  client.prepare('DELETE FROM radarr_movie_reservations WHERE target_id = ?').run(target.id);
}

/** Intentional retention completes the decision, without recording any Plex removal. */
export function finalizeRetainedPlexTarget(
  client: SqliteClient,
  target: DeletionWorkTarget,
  warning = 'Plex media intentionally retained to protect a kept download entry',
): void {
  const now = Math.floor(Date.now() / 1000);
  const changed = client.prepare(
    "UPDATE deletion_targets SET status = 'completed_with_warning', phase = 'finalizing', next_retry_at = NULL, error = NULL, warning = ?, storage_outcome = 'unknown', verified_hardlink_data_size = 0, storage_outcome_reasons = ?, updated_at = ? WHERE id = ? AND status = 'running' AND removal_confirmed_at IS NULL",
  ).run(
    warning,
    JSON.stringify(['Intentional retention; no Plex media removal or physical space claim']),
    now,
    target.id,
  );
  if (changed !== 1) throw new DeletionConvergenceError('retained deletion target state changed');
  client.prepare('DELETE FROM media_version_reservations WHERE target_id = ?').run(target.id);
  client.prepare('DELETE FROM radarr_movie_reservations WHERE target_id = ?').run(target.id);
}

/** Preserve completed effects while leaving unaccepted held actions for a fresh preview. */
export function markHeldServiceTarget(client: SqliteClient, target: DeletionWorkTarget): void {
  client.prepare(
    "UPDATE deletion_targets SET status='needs_attention', error='Some service actions remain held; review a fresh preview before authorizing them', next_retry_at=NULL, updated_at=? WHERE id=?",
  ).run(Math.floor(Date.now() / 1000), target.id);
}

export function assertRetainedVersionPostcondition(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
  live: NonNullable<Awaited<ReturnType<typeof validateDeletionTarget>>['live']>,
): void {
  const liveIds = new Set(live.media.map((entry) => entry.mediaId));
  const retainedMediaId = persistedRetainedMediaId(snapshot);
  if (retainedMediaId !== null) {
    if (!liveIds.has(retainedMediaId)) {
      throw new PlexReconciliationError(
        'The retained Plex version disappeared during reconciliation',
        true,
        false,
      );
    }
    return;
  }
  const operationIds = new Set(snapshot.operationMediaIds ?? [snapshot.mediaId!]);
  if (![...liveIds].some((mediaId) => !operationIds.has(mediaId))) {
    throw new PlexReconciliationError(
      'at least one unselected live Plex version must remain',
      true,
      false,
    );
  }
  if (target.targetKind === 'whole_item') {
    throw new PlexReconciliationError('invalid retained-version check', true, false);
  }
}
