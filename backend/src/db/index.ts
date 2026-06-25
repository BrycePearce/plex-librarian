import type { BindValue, Statement } from '@db/sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.ts';
import { openSqliteDb } from './util.ts';

const dbPath = Deno.env.get('DB_PATH') ?? './data/librarian.db';
const sqlite = openSqliteDb(dbPath);

export function withTransaction<T>(fn: (client: typeof sqlite) => T): T {
  return sqlite.transaction(() => fn(sqlite))();
}

const stmtCache = new Map<string, Statement>();

export const db = drizzle(
  (sql, params, method) => {
    const bindParams = params as BindValue[];
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = sqlite.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    if (method === 'run') {
      stmt.run(...bindParams);
      return Promise.resolve({ rows: [] });
    }
    // values() returns each row as an array — required by the sqlite-proxy contract
    const rows = stmt.values(...bindParams);
    return Promise.resolve({ rows: method === 'get' ? rows.slice(0, 1) : rows });
  },
  { schema },
);
