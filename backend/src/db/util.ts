import { Database } from '@db/sqlite';
import { dirname } from '@std/path';

export function ensureDbDir(dbPath: string): void {
  const dir = dirname(dbPath);
  if (dir && dir !== '.') {
    Deno.mkdirSync(dir, { recursive: true });
  }
}

export function openSqliteDb(path: string): Database {
  ensureDbDir(path);
  const db = new Database(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}
