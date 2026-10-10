import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';
const directory = await Deno.makeTempDir({ prefix: 'missing-query-test-' });
const path = resolve(directory, 'test.db');
Deno.env.set('DB_PATH', path);
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(path, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { execute, rows } = await import('./store.ts');
const { findingPredicate } = await import('./query.ts');
const defaults = { type: '', instance: 0, library: '', includeDismissed: false };
function setup() {
  withTransaction((db) => {
    db.exec(`DELETE FROM servers;
      INSERT INTO servers(id,machine_identifier,name,url,access_token,last_connected_at) VALUES(1,'one','One','http://plex.invalid','fixture',1),(2,'two','Two','http://plex.invalid','fixture',1);
      INSERT INTO libraries(server_id,key,title,type,synced_at) VALUES(1,'a','A','movie',1),(1,'b','B','movie',1),(2,'a','A','movie',1);
      INSERT INTO items(server_id,rating_key,library_key,title,type,added_at,updated_at) VALUES(1,'ignored','a','Ignored','movie',1,1),(2,'other','a','Other','movie',1,1);
      INSERT INTO ignored_content VALUES(1,'ignored',1),(2,'other',1);
      INSERT INTO arr_instances(id,server_id,type,name,url,api_key,created_at,updated_at) VALUES(1,1,'radarr','A','http://arr.invalid','fixture',1,1),(2,1,'radarr','B','http://arr-b.invalid','fixture',1,1),(3,2,'radarr','C','http://arr.invalid','fixture',1,1);`);
    for (let i = 0; i < 165; i++) {
      const server = i < 160 ? 1 : 2;
      execute(
        db,
        'INSERT INTO missing_findings VALUES(?,?,?,?,?,?,?,1,1,?,?)',
        server,
        server === 2 ? 3 : i % 2 + 1,
        i % 2 ? 'b' : 'a',
        i,
        ['missing', 'metadata', 'version', 'unable'][i % 4],
        `Title ${String(Math.floor(i / 2)).padStart(3, '0')}`,
        JSON.stringify({
          matches: i % 11 === 0
            ? [{ ratingKey: 'ignored' }]
            : i % 13 === 0
            ? [{ ratingKey: 'other' }]
            : [],
        }),
        i % 17 === 0 ? 1 : null,
        Number(i % 7 === 0),
      );
    }
  });
}
const original =
  `f.server_id=? AND f.resolved_at IS NULL AND (?='' OR f.type=?) AND (?=0 OR f.instance_id=?) AND (?='' OR f.library_key=?) AND (?=1 OR (f.dismissed=0 AND NOT EXISTS(SELECT 1 FROM json_each(f.evidence,'$.matches') m JOIN ignored_content i ON i.server_id=f.server_id AND i.rating_key=json_extract(m.value,'$.ratingKey'))))`;
Deno.test('finding filters preserve ignored/dismissed/server scope and stable pagination', () => {
  setup();
  withTransaction((db) => {
    for (const serverId of [1, 2]) {
      for (const type of ['', 'missing', 'metadata', 'version', 'unable']) {
        for (const instance of [0, 1, 2, 3]) {
          for (const library of ['', 'a', 'b']) {
            for (const includeDismissed of [false, true]) {
              const filters = { type, instance, library, includeDismissed };
              const improved = findingPredicate(db, serverId, filters);
              const oldArgs = [
                serverId,
                type,
                type,
                instance,
                instance,
                library,
                library,
                Number(includeDismissed),
              ];
              assertEquals(
                rows(
                  db,
                  `SELECT count(*) n FROM missing_findings f WHERE ${improved.where}`,
                  ...improved.args,
                ),
                rows(db, `SELECT count(*) n FROM missing_findings f WHERE ${original}`, ...oldArgs),
              );
              for (const offset of [0, 50, 100]) {
                const suffix =
                  ` ORDER BY f.title,f.instance_id,f.library_key,f.movie_id LIMIT 50 OFFSET ${offset}`;
                assertEquals(
                  rows(
                    db,
                    `SELECT f.* FROM missing_findings f WHERE ${improved.where}${suffix}`,
                    ...improved.args,
                  ),
                  rows(
                    db,
                    `SELECT f.* FROM missing_findings f WHERE ${original}${suffix}`,
                    ...oldArgs,
                  ),
                );
              }
            }
          }
        }
      }
    }
  });
});
Deno.test('ignored-content changes take effect on the next read without a sync', () => {
  setup();
  withTransaction((db) => {
    const count = () => {
      const p = findingPredicate(db, 1, defaults);
      return rows<{ n: number }>(
        db,
        `SELECT count(*) n FROM missing_findings f WHERE ${p.where}`,
        ...p.args,
      )[0].n;
    };
    const excluded = count();
    execute(db, 'DELETE FROM ignored_content WHERE server_id=1');
    const included = count();
    assertEquals(included > excluded, true);
    assertEquals(findingPredicate(db, 1, defaults).where.includes('json_each'), false);
    execute(db, "INSERT INTO ignored_content VALUES(1,'ignored',1)");
    assertEquals(count(), excluded);
  });
});
Deno.test('default finding page uses title order without an unbounded sort', () => {
  setup();
  withTransaction((db) => {
    const p = findingPredicate(db, 1, defaults);
    const plan = rows<{ detail: string }>(
      db,
      `EXPLAIN QUERY PLAN SELECT f.* FROM missing_findings f WHERE ${p.where} ORDER BY f.title,f.instance_id,f.library_key,f.movie_id LIMIT 50`,
      ...p.args,
    );
    assertEquals(plan.some((step) => step.detail.includes('TEMP B-TREE')), false);
    assertEquals(plan.some((step) => step.detail.includes('server_id=? AND rating_key=?')), true);
  });
});

Deno.test('setup-only versions are excluded before counts and pagination; comparable versions remain', () => {
  setup();
  withTransaction((db) => {
    execute(
      db,
      "UPDATE missing_findings SET evidence=json_set(evidence,'$.comparablePath','/verified/movie.mkv') WHERE movie_id=2",
    );
    const visible = findingPredicate(db, 1, {
      ...defaults,
      includeDismissed: true,
      hideSetupLimitations: true,
    });
    const result = rows<{ movie_id: number; type: string }>(
      db,
      `SELECT movie_id,type FROM missing_findings f WHERE ${visible.where} ORDER BY title LIMIT 50`,
      ...visible.args,
    );
    assertEquals(result.length, 50);
    assertEquals(result.filter((r) => r.type === 'version').map((r) => r.movie_id), [2]);
    const expected = rows(
      db,
      "SELECT count(*) n FROM missing_findings WHERE server_id=1 AND resolved_at IS NULL AND (type<>'version' OR movie_id=2)",
    );
    assertEquals(
      rows(db, `SELECT count(*) n FROM missing_findings f WHERE ${visible.where}`, ...visible.args),
      expected,
    );
  });
});
