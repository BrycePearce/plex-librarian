import { assertEquals, assertRejects } from '@std/assert';
import { resolve } from '@std/path';
import type { PlexClient, PlexRawMetadata } from '../../integrations/plex/index.ts';
import type { MissingContentResponse } from '../../../../shared/missingContent.ts';
const directory = await Deno.makeTempDir();
const path = resolve(directory, 'audit.db');
Deno.env.set('DB_PATH', path);
Deno.env.delete('PLEX_URL');
Deno.env.delete('PLEX_TOKEN');
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(path, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { execute, rows } = await import('./store.ts');
const { withMissingAudit } = await import('./audit.ts');
const { default: router } = await import('./route.ts');
const plex = { identity: () => Promise.resolve('active') } as unknown as PlexClient;
function reset() {
  withTransaction((db) => {
    db.exec(`UPDATE settings SET active_server_id=NULL; DELETE FROM sync_log; DELETE FROM servers;
      INSERT INTO servers(id,machine_identifier,name,url,access_token,last_connected_at) VALUES(1,'active','Test','http://plex.invalid','secret',1),(2,'other','Other','http://other.invalid','secret',1);
      INSERT INTO settings(id,client_id,active_server_id) VALUES(1,'test',1) ON CONFLICT(id) DO UPDATE SET active_server_id=1;
      INSERT INTO libraries(server_id,key,title,type,synced_at) VALUES(1,'hd','HD','movie',1),(1,'4k','4K','movie',1);
      INSERT INTO arr_instances(id,server_id,type,name,url,api_key,created_at,updated_at) VALUES(1,1,'radarr','HD','http://radarr.invalid','secret',1,1),(2,1,'radarr','4K','http://radarr4k.invalid','secret',1,1);
      INSERT INTO arr_library_mappings(server_id,library_key,arr_instance_id) VALUES(1,'hd',1),(1,'4k',2);
      INSERT INTO arr_path_mappings(arr_instance_id,kind,arr_path,local_path) VALUES(1,'library','/arr','/store'),(2,'library','/arr','/store');
      INSERT INTO plex_path_mappings(server_id,library_key,plex_path,local_path,validation_plex_path,validation_local_path,validation_size,validated_at,created_at,updated_at) VALUES(1,'hd','/plex','/store','/plex/a','/store/a',1,1,1,1),(1,'4k','/plex','/store','/plex/a','/store/a',1,1,1,1);
      INSERT INTO sync_log(id,server_id,started_at,status,items_processed) VALUES(1,1,1,'pending',0);`);
  });
}
const movie = (id: number) => ({
  id,
  title: `Movie ${id}`,
  year: 2000,
  titleSlug: `movie-${id}`,
  tmdbId: id,
  hasFile: true,
  movieFileId: id,
  movieFile: { id, movieId: id, path: `/arr/${id}.mkv`, dateAdded: '2020-01-01T00:00:00Z' },
  overview: 'x'.repeat(4000),
});
const item = (id: number): PlexRawMetadata => ({
  ratingKey: String(id),
  title: `Movie ${id}`,
  type: 'movie',
  Guid: [{ id: `tmdb://${id}` }],
  Media: [{ id, Part: [{ file: `/plex/${id}.mkv` }] }],
});
async function audit(
  options: {
    movies?: ReturnType<typeof movie>[];
    hd?: PlexRawMetadata[];
    fourK?: PlexRawMetadata[];
    fail?: string;
    incomplete?: boolean;
    change?: () => void;
    signal?: AbortSignal;
    queue?: unknown[];
    scope?: string;
    syncId?: number;
  } = {},
) {
  const calls: string[] = [];
  const fetcher = ((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.host + url.pathname);
    if (options.fail === url.host) return Promise.resolve(new Response('no', { status: 503 }));
    return Promise.resolve(
      Response.json(
        url.pathname.endsWith('/queue')
          ? { totalRecords: options.queue?.length ?? 0, records: options.queue ?? [] }
          : options.movies ?? [movie(1)],
      ),
    );
  }) as typeof fetch;
  await withMissingAudit(
    plex,
    1,
    options.syncId ?? 1,
    options.scope ?? null,
    options.signal ?? new AbortController().signal,
    (sink) => {
      sink.page('hd', options.hd ?? []);
      sink.page('4k', options.fourK ?? []);
      if (!options.incomplete) {
        sink.complete('hd');
        sink.complete('4k');
      }
      options.change?.();
      return Promise.resolve();
    },
    fetcher,
  );
  return calls;
}
const findings = () =>
  withTransaction((db) =>
    rows<{ type: string; resolved_at: number | null; dismissed: number; library_key: string }>(
      db,
      'SELECT type,resolved_at,dismissed,library_key FROM missing_findings ORDER BY library_key,movie_id',
    )
  );
async function page(query = '') {
  const res = await router.request('/' + query);
  assertEquals(res.status, 200);
  return res.json() as Promise<MissingContentResponse>;
}
Deno.test('complete independent scopes, metadata evidence and version matching', async () => {
  reset();
  await audit({
    movies: [movie(1), movie(2), movie(3), movie(4)],
    hd: [{ ...item(2), Guid: [{ id: 'tmdb://99' }] }, {
      ...item(3),
      Media: [{ id: 3, Part: [{ file: '/plex/alternate.mkv' }] }],
    }, { ...item(4), Guid: [] }],
  });
  assertEquals(findings().map((f) => f.type), [
    'missing',
    'missing',
    'missing',
    'missing',
    'missing',
    'metadata',
    'version',
    'metadata',
  ]);
  const saved = await page('?library=hd');
  assertEquals(saved.total, 4);
  assertEquals(saved.rows.every((r) => !r.stale), true);
  assertEquals(JSON.stringify(saved).includes('secret'), false);
});
Deno.test('one inventory per instance even with multiple mapped libraries', async () => {
  reset();
  withTransaction((db) =>
    execute(
      db,
      'INSERT INTO arr_library_mappings(server_id,library_key,arr_instance_id) VALUES(1,?,1)',
      '4k',
    )
  );
  const calls = await audit();
  assertEquals(calls.filter((c) => c === 'radarr.invalid/api/v3/movie').length, 1);
  assertEquals(findings().length, 3);
});
Deno.test('failed service retains stale results; another instance succeeds; later resolution', async () => {
  reset();
  await audit();
  await audit({ fail: 'radarr.invalid', fourK: [item(1)] });
  let data = await page();
  assertEquals(data.total, 1);
  assertEquals(data.rows[0].stale, true);
  assertEquals(data.scopes.find((s) => s.instanceId === 2)?.status, 'complete');
  await audit({ hd: [item(1)], fourK: [item(1)] });
  data = await page();
  assertEquals(data.total, 0);
  assertEquals(findings().every((f) => f.resolved_at !== null), true);
});
Deno.test('failed/incomplete Plex coverage never publishes or resolves and duplicates invalidate', async () => {
  reset();
  await audit();
  await audit({ hd: [item(1)], fourK: [item(1)], incomplete: true });
  assertEquals(findings().every((f) => f.resolved_at === null), true);
  await audit({ hd: [item(1), item(1)], fourK: [item(1)] });
  assertEquals((await page()).rows[0].stale, true);
});
Deno.test('configuration changes, server switches, cancellation and obsolete runs cannot publish', async () => {
  for (
    const change of [
      () =>
        withTransaction((db) =>
          execute(db, "UPDATE arr_instances SET url='http://changed.invalid' WHERE id=1")
        ),
      () => withTransaction((db) => execute(db, 'UPDATE settings SET active_server_id=2')),
      () => withTransaction((db) => execute(db, "UPDATE sync_log SET status='error' WHERE id=1")),
    ]
  ) {
    reset();
    await audit({ change });
    assertEquals(findings().length, 0);
  }
  reset();
  const abort = new AbortController();
  await audit({ signal: abort.signal, change: () => abort.abort() });
  assertEquals(findings().length, 0);
});
Deno.test('unknown namespace, title-only match, pending and recent imports are unable to verify', async () => {
  reset();
  withTransaction((db) => execute(db, 'DELETE FROM arr_path_mappings'));
  await audit({ hd: [{ ...item(50), title: 'Movie 1' }] });
  assertEquals(findings().every((f) => f.type === 'unable'), true);
  reset();
  await audit({ queue: [{ id: 1, movieId: 1 }] });
  assertEquals(findings().every((f) => f.type === 'unable'), true);
  reset();
  const m = movie(1);
  m.movieFile.dateAdded = new Date().toISOString();
  await audit({ movies: [m] });
  assertEquals(findings().every((f) => f.type === 'unable'), true);
});
Deno.test('malformed or duplicate Radarr records, incomplete queue and identity mismatch retain findings', async () => {
  reset();
  await audit();
  await audit({ movies: [movie(1), movie(1)] });
  assertEquals((await page()).rows.every((r) => r.stale), true);
  await audit({ queue: [{ id: 1 }] });
  assertEquals((await page()).rows.every((r) => r.stale), true);
  await withMissingAudit(
    { identity: () => Promise.resolve('foreign') } as unknown as PlexClient,
    1,
    1,
    null,
    new AbortController().signal,
    (sink) => {
      sink.page('hd', []);
      sink.complete('hd');
      return Promise.resolve();
    },
  );
  assertEquals((await page()).rows.every((r) => r.stale), true);
});
Deno.test('dismissals work without Plex keys, ignored matches are hidden, results paginate', async () => {
  reset();
  await audit({ movies: Array.from({ length: 60 }, (_, i) => movie(i + 1)) });
  const data = await page('?library=hd');
  assertEquals(data.total, 60);
  assertEquals(data.rows.length, 50);
  assertEquals((await page('?library=hd&offset=50')).rows.length, 10);
  const res = await router.request('/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: 1, libraryKey: 'hd', movieId: 1, dismissed: true }),
  });
  assertEquals(res.status, 200);
  assertEquals((await page('?library=hd')).total, 59);
  await audit({ movies: Array.from({ length: 60 }, (_, i) => movie(i + 1)) });
  assertEquals((await page('?library=hd')).total, 59);
  withTransaction((db) => {
    execute(
      db,
      "INSERT INTO items(server_id,rating_key,library_key,title,type,updated_at) VALUES(1,'1','hd','Movie 1','movie',1)",
    );
    execute(db, "INSERT INTO ignored_content(server_id,rating_key,created_at) VALUES(1,'1',1)");
  });
  await audit({ hd: [{ ...item(1), Guid: [] }], movies: [movie(1)] });
  assertEquals((await page('?library=hd')).total, 0);
  assertEquals((await page('?library=hd&dismissed=true')).total, 1);
});
Deno.test('task failure leaves completed independent scope eligible and staging always cleared', async () => {
  reset();
  await assertRejects(() =>
    withMissingAudit(
      plex,
      1,
      1,
      null,
      new AbortController().signal,
      () => Promise.reject(new Error('Plex failed')),
    )
  );
  assertEquals(findings().length, 0);
  assertEquals(withTransaction((db) => rows(db, 'SELECT * FROM missing_stage_plex')).length, 0);
});

Deno.test('case-insensitive trusted paths reconcile IDs and mapping revisions invalidate saved results', async () => {
  reset();
  withTransaction((db) =>
    execute(db, "UPDATE plex_path_mappings SET case_sensitive=0 WHERE library_key='hd'")
  );
  const matching = item(1);
  matching.Guid = [{ id: 'tmdb://99' }];
  matching.Media = [{ id: 1, Part: [{ file: '/PLEX/1.MKV' }] }];
  await audit({ hd: [matching] });
  assertEquals((await page('?library=hd')).rows[0].type, 'metadata');
  withTransaction((db) =>
    execute(db, "UPDATE plex_path_mappings SET revision=revision+1 WHERE library_key='hd'")
  );
  assertEquals((await page('?library=hd')).rows[0].stale, true);
});
Deno.test('an overlapping newer audit owns publication; reads never call provider inventories', async () => {
  reset();
  await audit({
    change: () => withTransaction((db) => execute(db, 'UPDATE missing_audit_scopes SET sync_id=2')),
  });
  assertEquals(findings().length, 0);
  const previous = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('Provider read forbidden'));
  try {
    assertEquals((await page()).total, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

Deno.test('contradictory Plex library ownership cannot establish presence', async () => {
  reset();
  await audit();
  await audit({ hd: [{ ...item(1), librarySectionID: '4k' }], fourK: [item(1)] });
  const data = await page('?library=hd');
  assertEquals(data.rows.length, 1);
  assertEquals(data.rows[0].stale, true);
});
