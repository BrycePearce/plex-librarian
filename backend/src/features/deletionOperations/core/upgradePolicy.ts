import { CURRENT_LOCATION_POLICY_VERSION } from '../../../../../shared/deletionPolicy.ts';
import type { SqliteClient } from '../../../db/index.ts';
import { refreshDeletionOperation } from './state.ts';

export const UPGRADE_HOLD = 'current_location_policy_update';
export const UPGRADE_PREVIEW_MESSAGE =
  'Deletion paused after update. No external attempt was found. Cancel this held work, then preview again after update.';
export const UPGRADE_RECOVERY_MESSAGE =
  'Deletion paused after update with external or uncertain attempt evidence. Review the recorded Plex, Arr and qBittorrent outcomes and restore any interrupted Arr monitoring or adoption in that service. Automatic deletion replay is disabled; keep this operation and its reservations for manual recovery. Absence alone does not prove success.';

export function currentLocationSnapshot(raw: unknown): boolean {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value?.currentLocationPolicyVersion === CURRENT_LOCATION_POLICY_VERSION;
  } catch {
    return false;
  }
}

// Worker claims are not external attempts. Snapshot transition checkpoints and the
// durable per-service intent tables are; unknown transition fields fail closed.
function snapshotHasAttempt(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(snapshotHasAttempt);
  return Object.entries(value).some(([key, entry]) => {
    if (key === 'upgradeHold') return false;
    if (
      /attempt|confirmedAt|protectedAt|protectionAt|restoredAt|adoptedAt|adoptedMediaId|commandId|createdExclusionId/i
        .test(key)
    ) {
      return entry !== undefined && entry !== null;
    }
    if (key === 'transition') return entry !== undefined && entry !== null;
    if (key === 'sonarrTransition') {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
      return Object.keys(entry).some((field) =>
        field !== 'candidateAllowlist' && field !== 'preDeletionPreflight'
      );
    }
    if (
      ['arrReassignments', 'arrOwnerships', 'cleanupDownloadRatingKeys'].includes(key) &&
      !Array.isArray(entry)
    ) return true;
    if (
      ['arrReassignments', 'arrOwnerships'].includes(key) && Array.isArray(entry) &&
      entry.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
    ) return true;
    if (
      [
        'seasonBreakGlass',
        'wholeSeasonRemoval',
        'wholeItemDownloadCleanup',
        'seasonDownloadCleanup',
        'radarrRemovalDownloadCleanup',
        'radarrRemovalFallback',
      ].includes(key) &&
      (!entry || typeof entry !== 'object' || Array.isArray(entry))
    ) return true;
    return snapshotHasAttempt(entry);
  });
}

export function upgradeTargetCanCancel(client: SqliteClient, targetId: number): boolean {
  const row = client.prepare(
    `SELECT t.snapshot, t.plex_attempt_count, t.removal_confirmed_at, t.plex_reconciled_at,
            o.server_id, t.phase
     FROM deletion_targets t JOIN deletion_operations o ON o.id = t.operation_id WHERE t.id = ?`,
  ).value<[string, number, number | null, number | null, number, string]>(targetId);
  if (!row || row[1] !== 0 || row[2] !== null || row[3] !== null) return false;
  try {
    const snapshot = JSON.parse(row[0]);
    if (
      !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      typeof snapshot.ratingKey !== 'string' || !snapshot.ratingKey ||
      typeof snapshot.libraryKey !== 'string' || snapshotHasAttempt(snapshot)
    ) return false;
    const keys = [
      snapshot.ratingKey,
      snapshot.showRatingKey,
      snapshot.seasonRatingKey,
      ...(Array.isArray(snapshot.cleanupDownloadRatingKeys)
        ? snapshot.cleanupDownloadRatingKeys
        : []),
    ];
    for (
      const table of [
        'arr_delete_attempts',
        'torrent_delete_attempts',
        'download_file_delete_attempts',
      ]
    ) {
      for (const ratingKey of keys.filter((key) => typeof key === 'string')) {
        if (
          client.prepare(`SELECT 1 FROM ${table} WHERE server_id = ? AND rating_key = ? LIMIT 1`)
            .value(row[4], ratingKey)
        ) return false;
      }
    }
    // Old mutation paths did not all checkpoint intent before every request.
    // Only a validation-phase target proves those paths were never entered.
    return row[5] === 'validating';
  } catch {
    return false;
  }
}

/** Call inside the caller's transaction before recovery, claiming, or user actions. */
export function holdLegacyDeletionTargets(client: SqliteClient, now: number): void {
  const rows = client.prepare(
    `SELECT id, operation_id, snapshot, status, phase, error FROM deletion_targets
     WHERE status NOT IN ('completed', 'cancelled')
       AND NOT (status = 'completed_with_warning' AND phase = 'finalizing')
       AND CASE WHEN json_valid(snapshot) THEN
         COALESCE(json_extract(snapshot, '$.currentLocationPolicyVersion'), -1) <> ${CURRENT_LOCATION_POLICY_VERSION}
         OR (target_kind = 'whole_item' AND COALESCE(json_extract(snapshot, '$.ordinaryPlan.policyVersion'), -1) <> ${CURRENT_LOCATION_POLICY_VERSION})
         ELSE 1 END`,
  ).values<[number, string, string, string, string, string | null]>();
  const operations = new Set<string>();
  for (const [id, operationId, raw, status, _phase, previousError] of rows) {
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      snapshot = null;
    }
    if (status === 'needs_attention' && snapshot?.upgradeHold === UPGRADE_HOLD) continue;
    const cancellable = upgradeTargetCanCancel(client, id);
    const error = cancellable ? UPGRADE_PREVIEW_MESSAGE : UPGRADE_RECOVERY_MESSAGE;
    // Preserve malformed evidence byte-for-byte. The error still gates execution;
    // malformed snapshots can never qualify for upgrade cancellation.
    const updated = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? JSON.stringify({
        ...snapshot,
        upgradeHold: UPGRADE_HOLD,
        ...(previousError ? { upgradePreviousError: previousError } : {}),
      })
      : raw;
    client.prepare(
      `UPDATE deletion_targets SET status = 'needs_attention', snapshot = ?, error = ?,
       next_retry_at = NULL, updated_at = ? WHERE id = ?`,
    ).run(updated, error, now, id);
    operations.add(operationId);
  }
  for (const operationId of operations) refreshDeletionOperation(client, operationId);
}
