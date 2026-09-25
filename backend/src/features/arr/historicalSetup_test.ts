import { assertEquals, assertRejects } from '@std/assert';
Deno.env.set('DB_PATH', ':memory:');
const { withTransaction } = await import('../../db/index.ts');
const {
  discoverHistoricalSetup,
  enableHistoricalSetup,
  resumeHistoricalSetupAfterSync,
  probeHistoricalTitles,
} = await import('./historicalSetup.ts');
const { listHistoricalAccess } = await import('./historicalDownloadAccess.ts');
const { serviceOwnedFingerprint } = await import('../mediaDeletion/serviceOwnedPlanning.ts');
withTransaction((db) =>
  db.exec(`CREATE TABLE servers(id INTEGER PRIMARY KEY);
  CREATE TABLE arr_instances(id INTEGER PRIMARY KEY,server_id INTEGER,type TEXT,url TEXT,api_key TEXT);
  CREATE TABLE arr_path_mappings(id INTEGER PRIMARY KEY,arr_instance_id INTEGER,kind TEXT,arr_path TEXT,local_path TEXT);
  CREATE TABLE arr_library_mappings(server_id INTEGER,arr_instance_id INTEGER,library_key TEXT);
  CREATE TABLE items(server_id INTEGER,library_key TEXT,tmdb_id INTEGER,tvdb_id INTEGER,added_at INTEGER);
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
    db.exec('DELETE FROM items; DELETE FROM arr_library_mappings');
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

Deno.test('bounded title fallback finds later evidence and stops after four reads', async () => {
  const reads: number[] = [];
  assertEquals(
    await probeHistoricalTitles([1, 2, 3, 4, 5], (id) => {
      reads.push(id);
      return Promise.resolve(id === 3 ? proposal : null);
    }),
    proposal,
  );
  assertEquals(reads, [1, 2, 3]);
  reads.length = 0;
  assertEquals(
    await probeHistoricalTitles([1, 2, 3, 4, 5], (id) => {
      reads.push(id);
      return Promise.reject(new Error('unavailable'));
    }),
    null,
  );
  assertEquals(reads, [1, 2, 3, 4]);
});

Deno.test('catalog sampling is bounded and existing items without usable IDs do not wait for first sync', async () => {
  reset();
  withTransaction((db) => {
    db.exec("INSERT INTO arr_library_mappings VALUES(1,1,'movies')");
    for (let index = 0; index < 64; index++) {
      db.exec("INSERT INTO items VALUES(1,'movies',NULL,NULL,1)");
    }
    db.exec("INSERT INTO items VALUES(1,'movies',12,NULL,2)");
  });
  await discoverHistoricalSetup(1, 1);
  assertEquals(listHistoricalAccess(1), []);
});

Deno.test('a changed mapping queues fresh discovery after an in-flight probe', async () => {
  reset();
  const first = Promise.withResolvers<typeof proposal | null>();
  const a = discoverHistoricalSetup(1, 1, () => first.promise);
  withTransaction((db) => db.exec("INSERT INTO arr_library_mappings VALUES(1,1,'movies')"));
  let reads = 0;
  const b = discoverHistoricalSetup(1, 1, () => {
    reads++;
    return Promise.resolve(proposal);
  });
  first.resolve(null);
  await Promise.all([a, b]);
  assertEquals(reads, 1);
  assertEquals(listHistoricalAccess(1)[0].status, 'ready_to_enable');
});

Deno.test('pending sync detection is durable, scoped and consumed once even when no sample appears', async () => {
  reset();
  await discoverHistoricalSetup(1, 1);
  assertEquals(listHistoricalAccess(1)[0].status, 'waiting_for_sync');
  assertEquals(listHistoricalAccess(1)[0].configuration.enabled, false);
  withTransaction((db) => db.exec("INSERT INTO arr_library_mappings VALUES(1,1,'movies')"));
  let reads = 0;
  const inspect = () => {
    reads++;
    return Promise.resolve(null);
  };
  await resumeHistoricalSetupAfterSync(2, null, inspect);
  await resumeHistoricalSetupAfterSync(1, 'tv', inspect);
  assertEquals(reads, 0);
  await resumeHistoricalSetupAfterSync(1, 'movies', inspect);
  await resumeHistoricalSetupAfterSync(1, null, inspect);
  assertEquals(reads, 1);
  assertEquals(listHistoricalAccess(1)[0].status, 'not_enabled');
});

Deno.test('deferred detection offers consent once and never overwrites a manual draft', async () => {
  reset();
  await discoverHistoricalSetup(1, 1);
  withTransaction((db) => db.exec("INSERT INTO arr_library_mappings VALUES(1,1,'movies')"));
  await resumeHistoricalSetupAfterSync(1, 'movies', () => Promise.resolve(proposal));
  assertEquals(listHistoricalAccess(1)[0].status, 'ready_to_enable');
  assertEquals(listHistoricalAccess(1)[0].configuration.enabled, false);
  reset();
  await discoverHistoricalSetup(1, 1);
  withTransaction((db) =>
    db.exec("UPDATE historical_download_access SET status='draft',revision='manual'")
  );
  let reads = 0;
  const inspect = () => {
    reads++;
    return Promise.resolve(proposal);
  };
  await discoverHistoricalSetup(1, 1, inspect);
  await resumeHistoricalSetupAfterSync(1, null, inspect);
  assertEquals(reads, 0);
  assertEquals(listHistoricalAccess(1)[0].revision, 'manual');
});

for (const manualEdit of [false, true]) {
  Deno.test(`deferred detection waits for capacity and ${manualEdit ? 'preserves manual edits' : 'runs once'}`, async () => {
    reset();
    await discoverHistoricalSetup(1, 1);
    withTransaction((db) => {
      db.exec("INSERT INTO arr_library_mappings VALUES(1,1,'movies')");
      for (let id = 2; id <= 5; id++) {
        db.prepare('INSERT INTO arr_instances VALUES(?,1,?,?,?)')
          .run(id, 'radarr', 'http://fixture.invalid', 'key');
      }
    });
    const held = Promise.withResolvers<null>();
    const blockers = [2, 3, 4, 5].map((id) => discoverHistoricalSetup(1, id, () => held.promise));
    let reads = 0;
    const inspect = () => {
      reads++;
      return Promise.resolve(proposal);
    };
    const callbacks = [
      resumeHistoricalSetupAfterSync(1, 'movies', inspect),
      resumeHistoricalSetupAfterSync(1, null, inspect),
    ];
    try {
      assertEquals(reads, 0);
      assertEquals(listHistoricalAccess(1)[0].status, 'waiting_for_sync');
      if (manualEdit) {
        withTransaction((db) =>
          db.exec("UPDATE historical_download_access SET status='draft',revision='manual'")
        );
      }
      held.resolve(null);
      await Promise.all([...blockers, ...callbacks]);
      await resumeHistoricalSetupAfterSync(1, null, inspect);
      assertEquals(reads, manualEdit ? 0 : 1);
      const saved = listHistoricalAccess(1)[0];
      assertEquals(saved.status, manualEdit ? 'draft' : 'ready_to_enable');
      assertEquals(saved.configuration.enabled, false);
      if (manualEdit) assertEquals(saved.revision, 'manual');
    } finally {
      held.resolve(null);
      await Promise.all([...blockers, ...callbacks]);
      withTransaction((db) => db.exec('DELETE FROM arr_instances WHERE id BETWEEN 2 AND 5'));
    }
  });
}

Deno.test('deferred detection consumes an empty sync and rejects changed connection revisions', async () => {
  reset();
  await discoverHistoricalSetup(1, 1);
  withTransaction((db) => db.exec("INSERT INTO arr_library_mappings VALUES(1,1,'movies')"));
  await resumeHistoricalSetupAfterSync(1, null);
  assertEquals(listHistoricalAccess(1)[0].status, 'not_enabled');
  await discoverHistoricalSetup(1, 1);
  assertEquals(listHistoricalAccess(1)[0].status, 'waiting_for_sync');
  withTransaction((db) => db.exec("UPDATE arr_instances SET api_key='changed'"));
  let reads = 0;
  await resumeHistoricalSetupAfterSync(1, null, () => {
    reads++;
    return Promise.resolve(proposal);
  });
  assertEquals(reads, 0);
  assertEquals(listHistoricalAccess(1)[0].status, 'not_enabled');
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

Deno.test('configuration invalidation can refresh an automatic offer but not a manual disabled root', async () => {
  reset();
  await discoverHistoricalSetup(1, 1, () => Promise.resolve(proposal));
  withTransaction((db) =>
    db.exec("UPDATE historical_download_access SET status='not_enabled',revision='invalidated'")
  );
  let reads = 0;
  const inspect = () => {
    reads++;
    return Promise.resolve(proposal);
  };
  await discoverHistoricalSetup(1, 1, inspect);
  assertEquals(reads, 1);
  assertEquals(listHistoricalAccess(1)[0].status, 'ready_to_enable');
  withTransaction((db) =>
    db.exec("UPDATE historical_download_access SET status='not_enabled',reason=NULL")
  );
  await discoverHistoricalSetup(1, 1, inspect);
  assertEquals(reads, 1);
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
