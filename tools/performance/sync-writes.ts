/** Synthetic in-memory SQLite benchmark; never contacts providers or opens the app DB.
 * Run from repository root: deno run -A tools/performance/sync-writes.ts
 */
import { Database } from 'jsr:@db/sqlite@^0.13.0';

Deno.env.set('DB_PATH', ':memory:');
const { SEASON_HISTORY_MAXIMUM_SQL } = await import(
  '../../backend/src/features/sync/historySync.ts'
);
const { applyArtistSizeBatch } = await import('../../backend/src/features/sync/mediaRollups.ts');
const { sqliteWriteBatches } = await import('../../backend/src/db/batch.ts');
const { createSyncYield } = await import('../../backend/src/features/sync/cooperativeYield.ts');
const client = new Database(':memory:');
const report: Record<string, unknown>[] = [];
try {
  client.exec(`
    CREATE TABLE seasons(server_id INTEGER, rating_key TEXT,show_rating_key TEXT,
      season_index INTEGER,library_key TEXT,last_viewed_at INTEGER,file_size INTEGER,
      PRIMARY KEY(server_id,rating_key));
    CREATE INDEX seasons_show_idx ON seasons(server_id,show_rating_key);
    CREATE INDEX seasons_library_idx ON seasons(server_id,library_key);
    CREATE INDEX seasons_library_stale_idx ON seasons(server_id,library_key,last_viewed_at);
    CREATE INDEX seasons_library_file_size_idx ON seasons(server_id,library_key,file_size);
    CREATE TABLE items(server_id INTEGER,rating_key TEXT,library_key TEXT,type TEXT,
      file_size INTEGER,PRIMARY KEY(server_id,rating_key));
    CREATE INDEX items_library_file_size_idx ON items(server_id,library_key,file_size);
  `);
  const seasons = client.prepare("INSERT INTO seasons VALUES(1,?,?,?,'tv',NULL,1000)");
  const items = client.prepare("INSERT INTO items VALUES(1,?,'music','artist',1000)");
  try {
    client.transaction(() => {
      for (let i = 0; i < 50000; i++) seasons.run(String(i), String(Math.floor(i / 5)), i % 5 + 1);
      for (let i = 0; i < 100000; i++) items.run(String(i));
    })();
  } finally {
    seasons.finalize();
    items.finalize();
  }
  for (const indexed of [false, true]) {
    client.exec('UPDATE seasons SET last_viewed_at=NULL');
    const query = indexed
      ? SEASON_HISTORY_MAXIMUM_SQL
      : SEASON_HISTORY_MAXIMUM_SQL.replace(' INDEXED BY seasons_show_idx', '');
    const planStatement = client.prepare(`EXPLAIN QUERY PLAN ${query}`);
    let plan;
    try {
      plan = planStatement.values(100, 1, '1', 1, 'tv', 100);
    } finally {
      planStatement.finalize();
    }
    const statement = client.prepare(query);
    const start = performance.now();
    try {
      client.transaction(() => {
        for (let i = 0; i < 1000; i++) statement.run(100, 1, String(i), 1, 'tv', 100);
      })();
    } finally {
      statement.finalize();
    }
    report.push({
      phase: 'season history',
      indexed,
      seasons: 50000,
      updates: 1000,
      ms: performance.now() - start,
      plan,
    });
  }
  for (const count of [10000, 100000]) {
    const totals: [string, number][] = Array.from({ length: count }, (_, i) => [String(i), 1000]);
    for (const bounded of [false, true]) {
      let maxTransactionMs = 0;
      const start = performance.now();
      if (bounded) {
        const yieldIfNeeded = createSyncYield();
        for (const batch of sqliteWriteBatches(totals)) {
          const transactionStart = performance.now();
          client.transaction(() => applyArtistSizeBatch(client, 1, 'music', batch))();
          maxTransactionMs = Math.max(maxTransactionMs, performance.now() - transactionStart);
          await yieldIfNeeded();
        }
      } else {
        const statement = client.prepare(
          "UPDATE items SET file_size=? WHERE server_id=? AND rating_key=? AND library_key=? AND type='artist'",
        );
        const transactionStart = performance.now();
        try {
          client.transaction(() => {
            for (const [key, size] of totals) statement.run(size, 1, key, 'music');
          })();
        } finally {
          statement.finalize();
        }
        maxTransactionMs = performance.now() - transactionStart;
      }
      report.push({
        phase: 'unchanged artist totals',
        bounded,
        artists: count,
        ms: performance.now() - start,
        maxTransactionMs,
      });
    }
  }
} finally {
  client.close();
}
console.log(JSON.stringify(report, null, 2));
