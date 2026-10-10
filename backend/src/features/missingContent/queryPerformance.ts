/** Synthetic count + 50-row page benchmark; isolated migrated DB, no providers. */
import { resolve } from '@std/path';
import type { BindValue } from '@db/sqlite';
const directory = await Deno.makeTempDir({ prefix: 'missing-query-benchmark-' });
const path = resolve(directory, 'benchmark.db');
Deno.env.set('DB_PATH', path);
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(path, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { execute, rows } = await import('./store.ts');
const { findingPredicate } = await import('./query.ts');
const count = Number(Deno.args[0] ?? 3000);
const iterations = Number(Deno.args[1] ?? 3);
if (
  !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(iterations) || iterations < 1
) throw new Error('Expected positive count and iterations');
withTransaction((db) => {
  db.exec(
    `INSERT INTO servers(id,machine_identifier,name,url,access_token,last_connected_at) VALUES(1,'fixture','Fixture','http://plex.invalid','fixture',1);
    INSERT INTO libraries(server_id,key,title,type,synced_at) VALUES(1,'a','A','movie',1);
    INSERT INTO arr_instances(id,server_id,type,name,url,api_key,created_at,updated_at) VALUES(1,1,'radarr','Fixture','http://arr.invalid','fixture',1,1);
    DROP INDEX missing_findings_title_page;`,
  );
  for (let i = 0; i < count; i++) {
    execute(
      db,
      "INSERT INTO missing_findings VALUES(1,1,'a',?,?,?,?,1,1,NULL,?)",
      i,
      ['missing', 'metadata', 'version', 'unable'][i % 4],
      `Movie ${String(i).padStart(8, '0')}`,
      JSON.stringify({
        movie: {
          id: i,
          title: `Movie ${i}`,
          path: `/arr/Movie ${i}/Movie.mkv`,
          slug: `movie-${i}`,
          tmdb: String(i),
          imdb: null,
          fileId: i,
          year: 2000,
          importedAt: 1,
        },
        reason: 'Synthetic catalog finding for performance measurement.',
        auditedAt: 1,
        comparablePath: `/store/Movie ${i}/Movie.mkv`,
        pending: false,
        matches: [{
          ratingKey: String(i),
          title: `Movie ${i}`,
          tmdb: [String(i)],
          imdb: [],
          paths: [`/plex/Movie ${i}/Movie.mkv`],
          exact: false,
        }],
      }),
      Number(i % 37 === 0),
    );
  }
  for (let i = 0; i < 100; i++) {
    execute(
      db,
      "INSERT INTO items(server_id,rating_key,library_key,title,type,updated_at) VALUES(1,?,'a','Ignored','movie',1)",
      String(i),
    );
  }
});
const baseline =
  `f.server_id=? AND f.resolved_at IS NULL AND (?='' OR f.type=?) AND (?=0 OR f.instance_id=?) AND (?='' OR f.library_key=?) AND (?=1 OR (f.dismissed=0 AND NOT EXISTS(SELECT 1 FROM json_each(f.evidence,'$.matches') m JOIN ignored_content i ON i.server_id=f.server_id AND i.rating_key=json_extract(m.value,'$.ratingKey'))))`;
const result: unknown[] = [];
for (const mode of ['before', 'after']) {
  if (mode === 'after') {
    withTransaction((db) =>
      db.exec(
        'CREATE INDEX missing_findings_title_page ON missing_findings(server_id,resolved_at,title,instance_id,library_key,movie_id,type,dismissed)',
      )
    );
  }
  for (const ignored of [0, 100]) {
    withTransaction((db) => {
      db.exec('DELETE FROM ignored_content');
      if (ignored) db.exec('INSERT INTO ignored_content SELECT server_id,rating_key,1 FROM items');
    });
    const times: number[] = [];
    let returned = 0, total = 0;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      withTransaction((db) => {
        const predicate = mode === 'before'
          ? { where: baseline, args: [1, '', '', 0, 0, '', '', 0] as BindValue[] }
          : findingPredicate(db, 1, {
            type: '',
            instance: 0,
            library: '',
            includeDismissed: false,
          });
        total = rows<{ n: number }>(
          db,
          `SELECT count(*) n FROM missing_findings f WHERE ${predicate.where}`,
          ...predicate.args,
        )[0].n;
        const page = rows<{ evidence: string }>(
          db,
          `SELECT f.* FROM missing_findings f WHERE ${predicate.where} ORDER BY f.title,f.instance_id,f.library_key,f.movie_id LIMIT 50`,
          ...predicate.args,
        );
        returned = page.length;
        for (const finding of page) JSON.parse(finding.evidence);
      });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const sample = {
      mode,
      findings: count,
      ignored,
      total,
      returned,
      iterations,
      medianMs: times[Math.floor(times.length / 2)],
      maxMs: times.at(-1),
      samplesMs: times,
    };
    result.push(sample);
    console.log(JSON.stringify(sample));
  }
}
console.log(
  JSON.stringify({
    kind: 'count-plus-50-row-page',
    storage: 'temporary-file-backed-SQLite',
    payload: 'synthetic-one-Plex-match-per-finding',
    results: result,
  }),
);
