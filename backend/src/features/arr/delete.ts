import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import type { SqliteClient } from '../../db/index.ts';
import { arrInstances, arrLibraryMappings, arrPathMappings } from '../../db/schema.ts';
import { ArrApiError, ArrClient } from '../../integrations/arr/client.ts';
import type { ArrPathMapping } from '@plex-librarian/shared/types.ts';

export interface CoordinatedDeleteItem {
  title: string;
  type: string;
  tmdbId: number | null;
  tvdbId: number | null;
}

export interface ArrDeleteTarget {
  instanceId: number;
  instanceName: string;
  client: ArrClient;
  addImportExclusion: boolean;
  pathMappings: ArrPathMapping[];
}

export interface ArrDeleteResult {
  deletedInstances: Array<{ instanceId: number; instanceName: string; alreadyAbsent: boolean }>;
  failures: Array<{ instanceId: number; instanceName: string; error: string }>;
}

export interface ArrDeleteOptions {
  attemptedInstanceIds?: ReadonlySet<number>;
  acceptAlreadyAbsent?: boolean;
  onAttemptStarting?: (target: ArrDeleteTarget) => Promise<void>;
}

export function arrDeleteDisposition(
  result: ArrDeleteResult,
): { status: 'complete' | 'partial' | 'failed'; shouldRefreshPlex: boolean } {
  return {
    status: result.failures.length === 0
      ? 'complete'
      : result.deletedInstances.length > 0
      ? 'partial'
      : 'failed',
    shouldRefreshPlex: result.deletedInstances.length > 0,
  };
}

function externalIdForItem(item: CoordinatedDeleteItem): number | null {
  return item.type === 'movie' ? item.tmdbId : item.type === 'show' ? item.tvdbId : null;
}

export function findAmbiguousExternalIds(
  client: SqliteClient,
  serverId: number,
  type: 'movie' | 'show',
  externalIds: readonly number[],
): Set<number> {
  const uniqueIds = [...new Set(externalIds)];
  if (uniqueIds.length === 0) return new Set();
  const column = type === 'movie' ? 'tmdb_id' : 'tvdb_id';
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const statement = client.prepare(
    `SELECT ${column} FROM items ` +
      `WHERE server_id = ? AND type = ? AND ${column} IN (${placeholders}) ` +
      `GROUP BY ${column} HAVING COUNT(*) > 1`,
  );
  try {
    return new Set(
      statement.values(serverId, type, ...uniqueIds).map((row) => Number(row[0])),
    );
  } finally {
    statement.finalize();
  }
}

export function assertArrDeleteIsUnambiguous(
  item: CoordinatedDeleteItem,
  ambiguousExternalIds: ReadonlySet<number>,
): void {
  const externalId = externalIdForItem(item);
  if (externalId === null || !ambiguousExternalIds.has(externalId)) return;
  throw new Error(
    `${item.title} shares its ${item.type === 'movie' ? 'TMDB' : 'TVDB'} ID with ` +
      'another Plex item; use Plex-only deletion or resolve the duplicate first',
  );
}

export async function getArrDeleteTargets(
  serverId: number,
  libraryKey: string,
): Promise<ArrDeleteTarget[]> {
  const rows = await db.select({
    instanceId: arrInstances.id,
    instanceName: arrInstances.name,
    type: arrInstances.type,
    url: arrInstances.url,
    apiKey: arrInstances.apiKey,
    addImportExclusion: arrLibraryMappings.addImportExclusion,
  }).from(arrLibraryMappings).innerJoin(
    arrInstances,
    eq(arrLibraryMappings.arrInstanceId, arrInstances.id),
  ).where(and(
    eq(arrLibraryMappings.serverId, serverId),
    eq(arrLibraryMappings.libraryKey, libraryKey),
    eq(arrInstances.serverId, serverId),
  ));

  const mappings = rows.length === 0 ? [] : await db.select().from(arrPathMappings).where(
    inArray(arrPathMappings.arrInstanceId, rows.map((row) => row.instanceId)),
  );
  return rows.map((row) => ({
    instanceId: row.instanceId,
    instanceName: row.instanceName,
    client: new ArrClient(row.type, row.url, row.apiKey),
    addImportExclusion: row.addImportExclusion,
    pathMappings: mappings.filter((mapping) => mapping.arrInstanceId === row.instanceId).map(
      (mapping) => ({
        kind: mapping.kind,
        arrPath: mapping.arrPath,
        localPath: mapping.localPath,
      }),
    ),
  }));
}

export async function deleteThroughArr(
  item: CoordinatedDeleteItem,
  targets: ArrDeleteTarget[],
  options: ArrDeleteOptions = {},
): Promise<ArrDeleteResult> {
  const externalId = externalIdForItem(item);
  if (externalId === null) {
    throw new Error(
      `${item.title} has no ${
        item.type === 'movie' ? 'TMDB' : 'TVDB'
      } ID; sync the library before coordinated deletion`,
    );
  }

  // Resolve every configured instance before mutating any of them. A confirmed miss is
  // safe (multi-instance setups commonly divide content), while a transport/auth error
  // is recorded and prevents any new delete from starting.
  const result: ArrDeleteResult = { deletedInstances: [], failures: [] };
  const matches: Array<{ target: ArrDeleteTarget; mediaId: number }> = [];
  for (const target of targets) {
    let record;
    try {
      record = await target.client.lookup(externalId);
    } catch (error) {
      result.failures.push({
        instanceId: target.instanceId,
        instanceName: target.instanceName,
        error: error instanceof Error ? error.message : 'lookup failed',
      });
      continue;
    }
    if (record) {
      matches.push({ target, mediaId: record.id });
    } else if (
      options.acceptAlreadyAbsent || options.attemptedInstanceIds?.has(target.instanceId)
    ) {
      // This target was durably marked immediately before an earlier DELETE. If it is
      // now absent, the desired state was reached even if the response was lost.
      result.deletedInstances.push({
        instanceId: target.instanceId,
        instanceName: target.instanceName,
        alreadyAbsent: true,
      });
    }
  }
  // Preserve the lookup-before-mutation guarantee. On retries, already-absent targets
  // remain visible as a partial result instead of being discarded by a later lookup
  // failure, but none of the records found above are mutated until every lookup works.
  if (result.failures.length > 0) return result;
  if (matches.length === 0 && result.deletedInstances.length === 0) {
    throw new Error(`${item.title} was not found in any mapped Arr instance`);
  }

  for (const { target, mediaId } of matches) {
    try {
      // Persist before issuing the destructive request. This closes the ambiguity where
      // Arr commits successfully but the connection drops before its response arrives.
      await options.onAttemptStarting?.(target);
      await target.client.deleteMedia(mediaId, target.addImportExclusion);
      result.deletedInstances.push({
        instanceId: target.instanceId,
        instanceName: target.instanceName,
        alreadyAbsent: false,
      });
    } catch (error) {
      // DELETE is idempotent: a record disappearing between lookup and mutation means
      // the requested final state has already been reached.
      if (error instanceof ArrApiError && error.status === 404) {
        result.deletedInstances.push({
          instanceId: target.instanceId,
          instanceName: target.instanceName,
          alreadyAbsent: true,
        });
        continue;
      }
      result.failures.push({
        instanceId: target.instanceId,
        instanceName: target.instanceName,
        error: error instanceof Error ? error.message : 'delete failed',
      });
    }
  }
  return result;
}
