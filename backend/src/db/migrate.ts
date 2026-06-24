import { resolve } from '@std/path';
import { openSqliteDb } from './util.ts';

export async function runMigrations(dbPath: string, migrationsDir: string): Promise<void> {
  const sqlite = openSqliteDb(dbPath);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER
    )
  `);

  type JournalEntry = { tag: string };
  const journal = JSON.parse(
    await Deno.readTextFile(`${migrationsDir}/meta/_journal.json`),
  ) as { entries: JournalEntry[] };

  for (const entry of journal.entries) {
    const checkStmt = sqlite.prepare('SELECT id FROM __drizzle_migrations WHERE hash = ?');
    const existing = checkStmt.get(entry.tag);
    checkStmt.finalize();
    if (existing) continue;

    const sqlText = await Deno.readTextFile(`${migrationsDir}/${entry.tag}.sql`);
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    sqlite.exec('BEGIN');
    const insertStmt = sqlite.prepare(
      'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
    );
    try {
      for (const stmt of statements) {
        sqlite.exec(stmt);
      }
      insertStmt.run(entry.tag, Math.floor(Date.now() / 1000));
      sqlite.exec('COMMIT');
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    } finally {
      insertStmt.finalize();
    }
    console.log(`Applied migration: ${entry.tag}`);
  }

  sqlite.close();
  console.log('Migrations complete.');
}

if (import.meta.main) {
  const dbPath = Deno.env.get('DB_PATH') ?? './data/librarian.db';
  const migrationsDir = resolve(import.meta.dirname!, '../../drizzle');
  await runMigrations(dbPath, migrationsDir);
}
