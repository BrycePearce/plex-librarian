import { assertEquals, assertRejects } from '@std/assert';
Deno.env.set('DB_PATH', ':memory:');
const { withTransaction } = await import('../../db/index.ts');
const { discoverHistoricalSetup, enableHistoricalSetup } = await import('./historicalSetup.ts');
const { listHistoricalAccess } = await import('./historicalDownloadAccess.ts');
const { serviceOwnedFingerprint } = await import('../mediaDeletion/serviceOwnedPlanning.ts');
withTransaction((db) =>
  db.exec(`CREATE TABLE servers(id INTEGER PRIMARY KEY);
  CREATE TABLE arr_instances(id INTEGER PRIMARY KEY,server_id INTEGER,type TEXT,url TEXT,api_key TEXT);
  CREATE TABLE arr_path_mappings(id INTEGER PRIMARY KEY,arr_instance_id INTEGER,kind TEXT,arr_path TEXT,local_path TEXT);
  CREATE TABLE arr_library_mappings(server_id INTEGER,arr_instance_id INTEGER,library_key TEXT);
  CREATE TABLE items(server_id INTEGER,library_key TEXT,tmdb_id INTEGER,tvdb_id INTEGER);
  INSERT INTO servers VALUES(1),(2);
  INSERT INTO arr_instances VALUES(1,1,'radarr','http://fixture.invalid','key');`)
);
const migration = await Deno.readTextFile(
  new URL('../../../drizzle/0059_tiny_star_brand.sql', import.meta.url),
);
withTransaction((db) => db.exec(migration.split('--> statement-breakpoint')[0]));
const proposal = {
  remoteRoot: '/remote/complete',
  localRoot: '/downloads',
  sample: '/remote/complete/Film.mkv',
  connectionRevision: serviceOwnedFingerprint([['radarr', 'http://fixture.invalid', 'key'], []]),
};
const reset = () =>
  withTransaction((db) => {
    db.exec('DELETE FROM historical_download_access');
    db.exec("UPDATE arr_instances SET api_key='key'");
  });

Deno.test('discovery stays disabled, coalesces and requires fresh scoped consent', async () => {
  reset();
  let reads = 0;
  const inspect = () => {
    reads++;
    return Promise.resolve(proposal);
  };
  await Promise.all([
    discoverHistoricalSetup(1, 1, inspect),
    discoverHistoricalSetup(1, 1, inspect),
  ]);
  assertEquals(reads, 1);
  const saved = listHistoricalAccess(1)[0];
  assertEquals(saved.status, 'ready_to_enable');
  assertEquals(saved.configuration.enabled, false);
  assertEquals(saved.problemRevision, null);
  await assertRejects(() => enableHistoricalSetup(2, saved.id, saved.revision, inspect));
  await assertRejects(() => enableHistoricalSetup(1, saved.id, 'stale', inspect));
  assertEquals(reads, 1);
  await enableHistoricalSetup(1, saved.id, saved.revision, inspect);
  assertEquals(reads, 2);
  assertEquals(listHistoricalAccess(1)[0].configuration.enabled, true);
  assertEquals(listHistoricalAccess(1)[0].configuration.noRemainingClient, false);
  await discoverHistoricalSetup(1, 1, inspect);
  assertEquals(reads, 2);
});

Deno.test('failed or superseded setup is silent and stale enable never succeeds', async () => {
  reset();
  await discoverHistoricalSetup(1, 1, () => Promise.resolve(null));
  assertEquals(listHistoricalAccess(1), []);
  await discoverHistoricalSetup(1, 1, () => {
    withTransaction((db) => db.exec("UPDATE arr_instances SET api_key='changed'"));
    return Promise.resolve(proposal);
  });
  assertEquals(listHistoricalAccess(1), []);
  reset();
  await discoverHistoricalSetup(1, 1, () => Promise.resolve(proposal));
  const saved = listHistoricalAccess(1)[0];
  await assertRejects(() =>
    enableHistoricalSetup(1, saved.id, saved.revision, () => Promise.resolve(null))
  );
  assertEquals(listHistoricalAccess(1)[0].configuration.enabled, false);
  assertEquals(listHistoricalAccess(1)[0].problemRevision, null);
  assertEquals(listHistoricalAccess(1)[0].status, 'not_enabled');
});

Deno.test('a manual edit during discovery wins and changed credentials invalidate consent', async () => {
  reset();
  await discoverHistoricalSetup(1, 1, () => {
    withTransaction((db) =>
      db.prepare(
        `INSERT INTO historical_download_access(id,server_id,arr_instance_id,configuration,revision,status)
      VALUES('manual',1,1,?,'manual','not_enabled')`,
      ).run(
        JSON.stringify({
          enabled: false,
          noRemainingClient: false,
          remoteRoot: '/manual',
          localRoot: '/mine',
        }),
      )
    );
    return Promise.resolve(proposal);
  });
  assertEquals(listHistoricalAccess(1)[0].configuration.localRoot, '/mine');
  assertEquals(listHistoricalAccess(1).length, 1);
  reset();
  await discoverHistoricalSetup(1, 1, () => Promise.resolve(proposal));
  const saved = listHistoricalAccess(1)[0];
  withTransaction((db) => db.exec("UPDATE arr_instances SET api_key='changed'"));
  let inspected = false;
  await assertRejects(() =>
    enableHistoricalSetup(1, saved.id, saved.revision, () => {
      inspected = true;
      return Promise.resolve(proposal);
    })
  );
  assertEquals(inspected, false);
  assertEquals(listHistoricalAccess(1)[0].configuration.enabled, false);
});
