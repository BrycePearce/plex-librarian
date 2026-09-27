import type { Database, Statement } from '@db/sqlite';

// IN lists and bulk writes produce a different SQL string for each batch size.
// Retain hot statements without keeping every historical query shape alive.
const MAX_CACHED_STATEMENTS = 256;

/** Owns statements used synchronously by the Drizzle proxy; callers must not retain them. */
export class StatementCache {
  private readonly statements = new Map<string, Statement>();

  constructor(
    private readonly client: Pick<Database, 'prepare'>,
    private readonly capacity = MAX_CACHED_STATEMENTS,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('statement cache capacity must be a positive integer');
    }
  }

  execute<T>(sql: string, run: (statement: Statement) => T): T {
    let statement = this.statements.get(sql);
    if (statement) {
      this.statements.delete(sql);
    } else {
      if (this.statements.size >= this.capacity) {
        const oldest = this.statements.entries().next().value!;
        this.statements.delete(oldest[0]);
        oldest[1].finalize();
      }
      statement = this.client.prepare(sql);
    }
    this.statements.set(sql, statement);

    try {
      return run(statement);
    } catch (error) {
      this.statements.delete(sql);
      // SQLite finalization can repeat the preceding execution error. Preserve the
      // original failure and prevent a later eviction from surfacing it again.
      try {
        statement.finalize();
      } catch {
        // The native statement is released even when finalize reports its error.
      }
      throw error;
    }
  }
}
