import { StatementCache } from '../../db/statementCache.ts';
import { createHash } from 'node:crypto';
import type { BindValue } from '@db/sqlite';
import { type SqliteClient, withTransaction } from '../../db/index.ts';

// Raw audit queries repeat for every movie; bound preparation cost and native handles.
const statementCaches = new WeakMap<SqliteClient, StatementCache>();
function statements(db: SqliteClient): StatementCache {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new StatementCache(db, 64);
    statementCaches.set(db, cache);
  }
  return cache;
}
export function rows<T>(db: SqliteClient, sql: string, ...args: BindValue[]): T[] {
  return statements(db).execute(sql, (stmt) => stmt.all(...args) as T[]);
}
export function execute(db: SqliteClient, sql: string, ...args: BindValue[]): void {
  statements(db).execute(sql, (stmt) => {
    stmt.run(...args);
  });
}
export interface Instance {
  id: number;
  name: string;
  url: string;
  api_key: string;
}
export interface Mapping {
  instance_id: number;
  library_key: string;
}
export interface Root {
  instance_id?: number;
  library_key?: string;
  source: string;
  target: string;
  caseSensitive?: boolean;
}
export function configuration(db: SqliteClient, serverId: number) {
  const instances = rows<Instance>(
    db,
    "SELECT id,name,url,api_key FROM arr_instances WHERE server_id=? AND type='radarr' ORDER BY id",
    serverId,
  );
  const mappings = rows<Mapping>(
    db,
    "SELECT m.arr_instance_id instance_id,m.library_key FROM arr_library_mappings m JOIN arr_instances a ON a.id=m.arr_instance_id AND a.server_id=m.server_id WHERE m.server_id=? AND a.type='radarr' ORDER BY 1,2",
    serverId,
  );
  const arrRoots = rows<Root>(
    db,
    "SELECT m.arr_instance_id instance_id,m.arr_path source,m.local_path target FROM arr_path_mappings m JOIN arr_instances a ON a.id=m.arr_instance_id WHERE a.server_id=? AND m.kind='library' ORDER BY m.id",
    serverId,
  );
  const plexRoots = rows<Root>(
    db,
    'SELECT library_key,plex_path source,local_path target,case_sensitive caseSensitive,revision,validated_at FROM plex_path_mappings WHERE server_id=? ORDER BY id',
    serverId,
  );
  for (const root of plexRoots) root.caseSensitive = !!root.caseSensitive;
  const server = rows<{ machine_identifier: string; url: string; access_token: string }>(
    db,
    'SELECT machine_identifier,url,access_token FROM servers WHERE id=?',
    serverId,
  )[0];
  // Includes secrets only in the one-way digest; never persist or return configuration itself.
  const fingerprint = createHash('sha256').update(
    JSON.stringify({
      instances,
      mappings,
      arrRoots,
      plexRoots,
      server,
      envUrl: Deno.env.get('PLEX_URL'),
      envToken: Deno.env.get('PLEX_TOKEN'),
    }),
  ).digest('hex');
  return { instances, mappings, arrRoots, plexRoots, server, fingerprint };
}
export function clearStage(syncId: number) {
  withTransaction((db) => {
    for (const table of ['plex', 'keys', 'movies', 'queue', 'findings']) {
      execute(db, `DELETE FROM missing_stage_${table} WHERE sync_id=?`, syncId);
    }
  });
}
