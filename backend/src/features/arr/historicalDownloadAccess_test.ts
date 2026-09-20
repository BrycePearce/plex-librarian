import { assertEquals, assertThrows } from '@std/assert';

Deno.env.set('DB_PATH', ':memory:');
const { withTransaction } = await import('../../db/index.ts');
const access = await import('./historicalDownloadAccess.ts');
withTransaction((db) => {
  db.exec(
    'CREATE TABLE servers(id INTEGER PRIMARY KEY); CREATE TABLE arr_instances(id INTEGER PRIMARY KEY, server_id INTEGER, type TEXT, url TEXT, api_key TEXT); CREATE TABLE arr_library_mappings(arr_instance_id INTEGER,server_id INTEGER,library_key TEXT); CREATE TABLE items(server_id INTEGER,library_key TEXT,tvdb_id INTEGER);',
  );
  db.exec(
    "INSERT INTO servers VALUES(1),(2); INSERT INTO arr_instances VALUES(1,1,'sonarr','http://fixture.invalid','fixture'),(2,2,'sonarr','http://fixture.invalid','fixture');",
  );
});
const migration = await Deno.readTextFile(
  new URL('../../../drizzle/0059_tiny_star_brand.sql', import.meta.url),
);
withTransaction((db) => db.exec(migration.split('--> statement-breakpoint')[0]));

const config = {
  enabled: true,
  remoteRoot: '/downloads',
  localRoot: '/cleanup-downloads',
  noRemainingClient: true,
};
function sample(id: string) {
  withTransaction((db) =>
    db.prepare('UPDATE historical_download_access SET sample=? WHERE id=?').run(
      '/downloads/release/file',
      id,
    )
  );
}

Deno.test('historical access coalesces checks, suppresses obsolete completions, scopes servers and invalidates client declarations', async () => {
  access.saveHistoricalAccess(1, 1, config);
  const id = access.listHistoricalAccess(1)[0].id;
  await access.checkHistoricalAccess(1, id);
  assertEquals(access.listHistoricalAccess(1)[0].status, 'waiting_for_sample');
  assertEquals(access.listHistoricalAccess(2), []);
  sample(id);
  let resolve!: () => void;
  const blocked = new Promise<void>((r) => {
    resolve = r;
  });
  let checks = 0;
  const checking = access.checkHistoricalAccess(1, id, async () => {
    checks++;
    await blocked;
    return null;
  });
  const coalesced = access.checkHistoricalAccess(1, id, () => {
    checks++;
    return Promise.resolve(null);
  });
  assertEquals(checking, coalesced);
  await Promise.resolve();
  await Promise.resolve();
  access.saveHistoricalAccess(1, 1, { ...config, enabled: false });
  resolve();
  await checking;
  assertEquals(checks, 1);
  assertEquals(access.listHistoricalAccess(1)[0].status, 'not_enabled');
  access.saveHistoricalAccess(1, 1, config);
  await access.checkHistoricalAccess(1, id);
  sample(id);
  await access.checkHistoricalAccess(1, id, () => Promise.resolve(null));
  assertEquals(access.listHistoricalAccess(1)[0].status, 'available');
  assertEquals(access.listHistoricalAccess(1)[0].checkedAt! > 2 ** 31, true);
  assertEquals(access.listHistoricalAccess(1)[0].succeededAt! > 2 ** 31, true);
  await access.checkHistoricalAccess(1, id, () => Promise.reject(new Error('readonly fixture')));
  const failure = access.listHistoricalAccess(1)[0];
  assertEquals(failure.status, 'access_lost');
  assertEquals(failure.succeededAt !== null, true);
  access.supplyHistoricalSample(1, 1, '/downloads/release/file');
  await Promise.resolve();
  assertEquals(access.listHistoricalAccess(1)[0].status, 'access_lost');
  assertEquals(access.listHistoricalAccess(1)[0].checkedAt, failure.checkedAt);
  withTransaction((db) =>
    db.prepare(
      'UPDATE historical_download_access SET dismissed_revision=problem_revision WHERE id=?',
    ).run(id)
  );
  await access.checkHistoricalAccess(1, id, () => Promise.reject(new Error('readonly fixture')));
  assertEquals(
    access.listHistoricalAccess(1)[0].problemRevision,
    access.listHistoricalAccess(1)[0].dismissedRevision,
  );
  await access.checkHistoricalAccess(1, id, () => Promise.resolve(null));
  assertEquals(access.listHistoricalAccess(1)[0].problemRevision, null);
  access.invalidateHistoricalAccessConfiguration(1);
  await access.checkHistoricalAccess(1, id);
  assertEquals(access.listHistoricalAccess(1)[0].configuration.noRemainingClient, false);
});

Deno.test('uncovered history reports no attempted local path; explicit existing download mappings are reused', async () => {
  access.supplyHistoricalSample(2, 2, '/new-source/release/file');
  const unconfigured = access.listHistoricalAccess(2)[0];
  assertEquals(unconfigured.configuration.enabled, false);
  assertEquals(unconfigured.configuration.localRoot, '');
  assertEquals(unconfigured.reason?.includes('no Librarian path was attempted'), true);
  for (let i = 0; i < 25; i++) access.supplyHistoricalSample(2, 2, `/other-${i}/release/file`);
  assertEquals(access.listHistoricalAccess(2).length, 1, 'one unresolved draft per connection');
  access.supplyHistoricalSample(2, 2, '/mapped/release/file', [{
    kind: 'download',
    arrPath: '/mapped',
    localPath: '/cleanup',
  }]);
  const mapped = access.listHistoricalAccess(2).find((s) =>
    s.configuration.remoteRoot === '/mapped'
  )!;
  await access.checkHistoricalAccess(2, mapped.id);
  assertEquals(mapped.configuration.localRoot, '/cleanup');
  assertEquals(mapped.configuration.enabled, true);
  assertEquals(access.listHistoricalAccess(2).length, 2);
});

Deno.test('correcting a suggested root updates its record and invalidates obsolete checks without duplicate drafts', async () => {
  withTransaction((db) => db.exec('DELETE FROM historical_download_access'));
  access.supplyHistoricalSample(1, 1, '/completed/release/episode.mkv');
  const draft = access.listHistoricalAccess(1)[0];
  assertEquals(draft.configuration.remoteRoot, '/completed/release');
  access.saveHistoricalAccess(1, 1, { ...config, remoteRoot: '/completed/release' }, draft.id);
  await access.checkHistoricalAccess(1, draft.id);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const oldCheck = access.checkHistoricalAccess(1, draft.id, async () => {
    await blocked;
    return null;
  });
  await Promise.resolve();
  await Promise.resolve();
  const before = access.listHistoricalAccess(1)[0];
  access.saveHistoricalAccess(
    1,
    1,
    { ...config, enabled: false, remoteRoot: '/completed' },
    draft.id,
  );
  release();
  await oldCheck;
  access.supplyHistoricalSample(1, 1, '/completed/another-release/episode.mkv');
  const corrected = access.listHistoricalAccess(1)[0];
  assertEquals(access.listHistoricalAccess(1).length, 1);
  assertEquals(corrected.id, draft.id);
  assertEquals(corrected.revision === before.revision, false);
  assertEquals(corrected.status, 'not_enabled');
  assertEquals(corrected.succeededAt, null);
  assertEquals(
    access.historicalTranslation(corrected.sample!, corrected.configuration),
    '/cleanup-downloads/release/episode.mkv',
  );
  assertThrows(() => access.saveHistoricalAccess(2, 2, config, draft.id));
  access.saveHistoricalAccess(1, 1, { ...config, enabled: false, remoteRoot: '/another' });
  assertThrows(() =>
    access.saveHistoricalAccess(1, 1, { ...config, remoteRoot: '/another' }, draft.id)
  );
  access.saveHistoricalAccess(
    1,
    1,
    { ...config, enabled: false, remoteRoot: '/unrelated' },
    draft.id,
  );
  assertEquals(access.listHistoricalAccess(1).find((s) => s.id === draft.id)!.sample, null);
  access.supplyHistoricalSample(1, 1, '/completed/release/episode.mkv');
  const rediscovered = access.listHistoricalAccess(1).find((s) =>
    s.configuration.remoteRoot === '/completed/release'
  )!;
  assertEquals(rediscovered.sample, '/completed/release/episode.mkv');
  assertEquals(rediscovered.id === draft.id, false);
  assertEquals(
    access.listHistoricalAccess(1).find((s) => s.id === draft.id)!.configuration.remoteRoot,
    '/unrelated',
  );
});
