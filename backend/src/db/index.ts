import type { BindValue } from '@db/sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.ts';
import { openSqliteDb } from './util.ts';
import { StatementCache } from './statementCache.ts';

const dbPath = Deno.env.get('DB_PATH') ?? './data/librarian.db';
const sqlite = openSqliteDb(dbPath);

export type SqliteClient = typeof sqlite;

export function withTransaction<T>(fn: (client: SqliteClient) => T): T {
  return sqlite.transaction(() => fn(sqlite))();
}

const stmtCache = new StatementCache(sqlite);

export const db = drizzle(
  (sql, params, method) => {
    const bindParams = params as BindValue[];
    // All native work completes before returning the promise, so eviction cannot
    // finalize a statement while another proxy call is still consuming its rows.
    return Promise.resolve(stmtCache.execute(sql, (stmt) => {
      if (method === 'run') {
        stmt.run(...bindParams);
        return { rows: [] };
      }
      // values() returns each row as an array — required by the sqlite-proxy contract
      const rows = stmt.values(...bindParams);
      return { rows: method === 'get' ? rows.slice(0, 1) : rows };
    }));
  },
  { schema },
);
