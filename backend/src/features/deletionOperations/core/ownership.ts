import { type SQL, sql } from 'drizzle-orm';
import { deletionOperations, deletionTargets } from '../../../db/schema.ts';

// One lifecycle definition for projection roots that are still owned by durable work.
// Terminal targets stop owning normal library insight unless Plex reconciliation or a
// relocation handshake is still open. A finalized external-removal warning has already
// released reservations and is deliberately actionable again; an unresolved warning
// remains in plex_reconciliation and continues to own its root.
export const WORKFLOW_OWNED_TARGET_SQL = `(
  t.status IN ('queued', 'running', 'waiting_retry', 'needs_attention')
  OR (t.status = 'completed_with_warning' AND t.phase <> 'finalizing')
  OR (
    json_type(t.snapshot, '$.relocationGuidance') IS NOT NULL
    AND json_type(t.snapshot, '$.relocationSyncBarrier') IS NULL
  )
  OR (
    json_type(t.snapshot, '$.relocationSyncBarrier') IS NOT NULL
    AND json_extract(t.snapshot, '$.relocationSyncBarrier.finishedAt') IS NULL
  )
)`;

const ownedTargetState = sql.raw(
  WORKFLOW_OWNED_TARGET_SQL.replaceAll('t.', 'deletion_targets.'),
);

function ownedTargetExists(
  serverId: number | SQL,
  libraryKey: string | SQL,
  identity: SQL,
): SQL {
  return sql`exists (
    select 1
    from ${deletionTargets}
    inner join ${deletionOperations}
      on ${deletionOperations.id} = ${deletionTargets.operationId}
    where ${deletionOperations.serverId} = ${serverId}
      and ${deletionOperations.libraryKey} = ${libraryKey}
      and ${ownedTargetState}
      and ${identity}
  )`;
}

export function movieRootIsWorkflowOwned(
  serverId: number | SQL,
  libraryKey: string | SQL,
  ratingKey: string | SQL,
): SQL {
  return ownedTargetExists(
    serverId,
    libraryKey,
    sql`${deletionTargets.targetKind} in ('whole_item', 'movie_version')
      and json_extract(${deletionTargets.snapshot}, '$.ratingKey') = ${ratingKey}`,
  );
}

export function episodeRootIsWorkflowOwned(
  serverId: number | SQL,
  libraryKey: string | SQL,
  episodeRatingKey: string | SQL,
  showRatingKey: string | SQL,
): SQL {
  return ownedTargetExists(
    serverId,
    libraryKey,
    sql`(
      (${deletionTargets.targetKind} = 'episode_version'
        and json_extract(${deletionTargets.snapshot}, '$.ratingKey') = ${episodeRatingKey})
      or (${deletionTargets.targetKind} = 'whole_item'
        and json_extract(${deletionTargets.snapshot}, '$.ratingKey') = ${showRatingKey})
    )`,
  );
}

export function showRootIsWorkflowOwned(
  serverId: number | SQL,
  libraryKey: string | SQL,
  showRatingKey: string | SQL,
): SQL {
  return ownedTargetExists(
    serverId,
    libraryKey,
    sql`(
      (${deletionTargets.targetKind} = 'whole_item'
        and json_extract(${deletionTargets.snapshot}, '$.ratingKey') = ${showRatingKey})
      or (${deletionTargets.targetKind} = 'episode_version'
        and json_extract(${deletionTargets.snapshot}, '$.showRatingKey') = ${showRatingKey})
    )`,
  );
}

// Raw-SQL counterpart for the bounded stale quick-cleanup queries, whose item alias is
// intentionally fixed as `i`. It shares the lifecycle fragment above instead of
// inventing a second status list.
export function workflowOwnedItemSql(libraryType: string): string {
  const identity = libraryType === 'show'
    ? `(
        (t.target_kind = 'whole_item' AND json_extract(t.snapshot, '$.ratingKey') = i.rating_key)
        OR (t.target_kind = 'episode_version'
          AND json_extract(t.snapshot, '$.showRatingKey') = i.rating_key)
      )`
    : `t.target_kind IN ('whole_item', 'movie_version')
      AND json_extract(t.snapshot, '$.ratingKey') = i.rating_key`;
  return `EXISTS (
    SELECT 1 FROM deletion_targets t
    JOIN deletion_operations o ON o.id = t.operation_id
    WHERE o.server_id = i.server_id
      AND o.library_key = i.library_key
      AND ${WORKFLOW_OWNED_TARGET_SQL}
      AND (${identity})
  )`;
}
