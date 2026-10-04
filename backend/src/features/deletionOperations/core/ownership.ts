import { type SQL, sql } from 'drizzle-orm';
import { deletionOperations, deletionTargets } from '../../../db/schema.ts';

// One lifecycle definition for projection roots that are still owned by durable work.
// Terminal targets stop owning normal library insight unless Plex reconciliation or a
// relocation handshake is still open. A finalized audit warning has already released
// reservations and is deliberately actionable again; an unresolved warning remains in
// plex_reconciliation and continues to own its root.
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
  seasonRatingKey: string | SQL,
): SQL {
  return ownedTargetExists(
    serverId,
    libraryKey,
    sql`(
      (${deletionTargets.targetKind} = 'episode_version'
        and json_extract(${deletionTargets.snapshot}, '$.ratingKey') = ${episodeRatingKey})
      or (${deletionTargets.targetKind} = 'whole_item'
        and (json_extract(${deletionTargets.snapshot}, '$.ratingKey') = ${showRatingKey}
          or (json_extract(${deletionTargets.snapshot}, '$.type') = 'season'
            and json_extract(${deletionTargets.snapshot}, '$.ratingKey') = ${seasonRatingKey})))
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
        and (json_extract(${deletionTargets.snapshot}, '$.ratingKey') = ${showRatingKey}
          or (json_extract(${deletionTargets.snapshot}, '$.type') = 'season'
            and json_extract(${deletionTargets.snapshot}, '$.showRatingKey') = ${showRatingKey})))
      or (${deletionTargets.targetKind} = 'episode_version'
        and json_extract(${deletionTargets.snapshot}, '$.showRatingKey') = ${showRatingKey})
    )`,
  );
}

export function seasonRootIsWorkflowOwned(
  serverId: number | SQL,
  libraryKey: string | SQL,
  seasonRatingKey: string | SQL,
  showRatingKey: string | SQL,
): SQL {
  return ownedTargetExists(
    serverId,
    libraryKey,
    sql`(
      (${deletionTargets.targetKind} = 'whole_item'
        and (
          json_extract(${deletionTargets.snapshot}, '$.ratingKey') = ${showRatingKey}
          or (
            json_extract(${deletionTargets.snapshot}, '$.type') = 'season'
            and json_extract(${deletionTargets.snapshot}, '$.ratingKey') = ${seasonRatingKey}
          )
        ))
      or (${deletionTargets.targetKind} = 'episode_version'
        and json_extract(${deletionTargets.snapshot}, '$.seasonRatingKey') = ${seasonRatingKey})
    )`,
  );
}

// List reads should evaluate lifecycle and JSON identity facts once per server,
// rather than repeating the deletion-history scan for every candidate media row.
// The tuple retains each operation's library when a list spans several libraries.
// A fixed numeric server ID keeps these root sets independent of candidate rows.
function ownedRootKeys(
  serverId: number,
  libraryKey: string | SQL,
  kinds: SQL,
  rootKey: SQL,
): SQL {
  return sql`select ${deletionOperations.libraryKey}, ${rootKey}
    from ${deletionTargets}
    inner join ${deletionOperations}
      on ${deletionOperations.id} = ${deletionTargets.operationId}
    where ${deletionOperations.serverId} = ${serverId}
      ${
    typeof libraryKey === 'string'
      ? sql`and ${deletionOperations.libraryKey} = ${libraryKey}`
      : sql``
  }
      and ${ownedTargetState} and ${kinds} and ${rootKey} is not null`;
}

function rootInOwnedKeys(libraryKey: string | SQL, rootKey: SQL, keys: SQL): SQL {
  // Missing candidate identity never satisfied the original equality-based EXISTS.
  // COALESCE also prevents a nullable tuple from becoming an unknown NOT IN result.
  return sql`coalesce((${libraryKey}, ${rootKey}) in (${keys}), false)`;
}

export function movieRootIsWorkflowOwnedForRead(
  serverId: number,
  libraryKey: string | SQL,
  ratingKey: SQL,
): SQL {
  return rootInOwnedKeys(
    libraryKey,
    ratingKey,
    ownedRootKeys(
      serverId,
      libraryKey,
      sql`${deletionTargets.targetKind} in ('whole_item', 'movie_version')`,
      sql`json_extract(${deletionTargets.snapshot}, '$.ratingKey')`,
    ),
  );
}

export function showRootIsWorkflowOwnedForRead(
  serverId: number,
  libraryKey: string | SQL,
  showRatingKey: SQL,
): SQL {
  const directKeys = ownedRootKeys(
    serverId,
    libraryKey,
    sql`${deletionTargets.targetKind} = 'whole_item'`,
    sql`json_extract(${deletionTargets.snapshot}, '$.ratingKey')`,
  );
  const ancestorKeys = ownedRootKeys(
    serverId,
    libraryKey,
    sql`(${deletionTargets.targetKind} = 'episode_version'
      or (${deletionTargets.targetKind} = 'whole_item'
        and json_extract(${deletionTargets.snapshot}, '$.type') = 'season'))`,
    sql`json_extract(${deletionTargets.snapshot}, '$.showRatingKey')`,
  );
  return rootInOwnedKeys(libraryKey, showRatingKey, sql`${directKeys} union all ${ancestorKeys}`);
}

export function seasonRootIsWorkflowOwnedForRead(
  serverId: number,
  libraryKey: string | SQL,
  seasonRatingKey: SQL,
  showRatingKey: SQL,
): SQL {
  const wholeShowKeys = ownedRootKeys(
    serverId,
    libraryKey,
    sql`${deletionTargets.targetKind} = 'whole_item'`,
    sql`json_extract(${deletionTargets.snapshot}, '$.ratingKey')`,
  );
  const wholeSeasonKeys = ownedRootKeys(
    serverId,
    libraryKey,
    sql`${deletionTargets.targetKind} = 'whole_item'
      and json_extract(${deletionTargets.snapshot}, '$.type') = 'season'`,
    sql`json_extract(${deletionTargets.snapshot}, '$.ratingKey')`,
  );
  const episodeSeasonKeys = ownedRootKeys(
    serverId,
    libraryKey,
    sql`${deletionTargets.targetKind} = 'episode_version'`,
    sql`json_extract(${deletionTargets.snapshot}, '$.seasonRatingKey')`,
  );
  return sql`(${rootInOwnedKeys(libraryKey, showRatingKey, wholeShowKeys)}
    or ${
    rootInOwnedKeys(
      libraryKey,
      seasonRatingKey,
      sql`${wholeSeasonKeys} union all ${episodeSeasonKeys}`,
    )
  })`;
}

export function episodeRootIsWorkflowOwnedForRead(
  serverId: number,
  libraryKey: string | SQL,
  episodeRatingKey: SQL,
  showRatingKey: SQL,
  seasonRatingKey: SQL,
): SQL {
  const episodeKeys = ownedRootKeys(
    serverId,
    libraryKey,
    sql`${deletionTargets.targetKind} = 'episode_version'`,
    sql`json_extract(${deletionTargets.snapshot}, '$.ratingKey')`,
  );
  const wholeShowKeys = ownedRootKeys(
    serverId,
    libraryKey,
    sql`${deletionTargets.targetKind} = 'whole_item'`,
    sql`json_extract(${deletionTargets.snapshot}, '$.ratingKey')`,
  );
  const wholeSeasonKeys = ownedRootKeys(
    serverId,
    libraryKey,
    sql`${deletionTargets.targetKind} = 'whole_item'
      and json_extract(${deletionTargets.snapshot}, '$.type') = 'season'`,
    sql`json_extract(${deletionTargets.snapshot}, '$.ratingKey')`,
  );
  return sql`(${rootInOwnedKeys(libraryKey, episodeRatingKey, episodeKeys)}
    or ${rootInOwnedKeys(libraryKey, showRatingKey, wholeShowKeys)}
    or ${rootInOwnedKeys(libraryKey, seasonRatingKey, wholeSeasonKeys)})`;
}

// Raw-SQL counterpart for the bounded stale quick-cleanup queries, whose item alias is
// intentionally fixed as `i`. It shares the lifecycle fragment above instead of
// inventing a second status list.
export function workflowOwnedItemSql(libraryType: string): string {
  const identity = libraryType === 'show'
    ? `(
        (t.target_kind = 'whole_item' AND (json_extract(t.snapshot, '$.ratingKey') = i.rating_key
          OR (json_extract(t.snapshot, '$.type') = 'season'
            AND json_extract(t.snapshot, '$.showRatingKey') = i.rating_key)))
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
