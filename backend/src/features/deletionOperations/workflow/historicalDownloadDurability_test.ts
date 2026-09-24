import { strictEqual, throws } from 'node:assert';
import { runHistoricalDownloadAttempt } from './historicalDownloadJournal.ts';
import { serviceOwnedFingerprint } from '../../mediaDeletion/serviceOwnedPlanning.ts';
import {
  planServiceOwnedRetention,
  type ServiceOwnedAction,
} from '../../mediaDeletion/serviceOwnedRetention.ts';

Deno.env.set('DB_PATH', ':memory:');
const { withTransaction } = await import('../../../db/index.ts');
const { historicalDownloadJournalStore, ensureHistoricalDownloadPhase } = await import(
  './historicalDownloadWorkflow.ts'
);
const { executeServiceOwnedActions } = await import('./serviceOwnedWorkflow.ts');

Deno.test('SQLite optional results and reservations remain isolated from real service action execution and retries', async () => {
  const migration = await Deno.readTextFile(
    new URL('../../../../drizzle/0059_tiny_star_brand.sql', import.meta.url),
  );
  const validationMigration = await Deno.readTextFile(
    new URL('../../../../drizzle/0060_yellow_stature.sql', import.meta.url),
  );
  withTransaction((db) => {
    db.exec(
      'CREATE TABLE servers(id INTEGER PRIMARY KEY); CREATE TABLE arr_instances(id INTEGER PRIMARY KEY); CREATE TABLE deletion_operations(id TEXT PRIMARY KEY);',
    );
    for (const sql of migration.split('--> statement-breakpoint')) db.exec(sql);
    db.exec(validationMigration);
  });
  for (
    const scenario of [
      'success',
      'failed',
      'uncertain',
      'intent',
      'skipped',
      'lost-completion',
    ] as const
  ) {
    const id = scenario;
    withTransaction((db) => {
      db.prepare('INSERT INTO deletion_operations(id) VALUES(?)').run(id);
      db.prepare(
        'INSERT INTO historical_download_journal(id,operation_id,entry,evidence,status) VALUES(?,?,?,?,?)',
      )
        .run(id, id, 'shared:' + id, '{}', scenario === 'intent' ? 'intent' : 'pending');
      db.prepare('INSERT INTO historical_download_reservations(entry,journal_id) VALUES(?,?)').run(
        'shared:' + id,
        id,
      );
      // The global physical entry key rejects another operation, including aliases
      // represented by that same canonical key, before any unlink can be attempted.
      throws(() =>
        db.prepare('INSERT INTO historical_download_reservations(entry,journal_id) VALUES(?,?)')
          .run('shared:' + id, id)
      );
    });
    const durable = historicalDownloadJournalStore(id, 'shared:' + id);
    let unlinks = 0;
    const store = {
      get: durable.get,
      save: (attempt: Parameters<typeof durable.save>[0]) => {
        if (scenario === 'lost-completion' && attempt.status === 'success') {
          throw new Error('completion write lost');
        }
        durable.save(attempt);
      },
    };
    const hooks = {
      cancelled: () => scenario === 'skipped',
      validate: () => Promise.resolve('ready' as const),
      unlink: () => {
        strictEqual(durable.get().status, 'intent');
        unlinks++;
        if (scenario === 'failed') throw new Deno.errors.PermissionDenied('injected EACCES');
        if (scenario === 'uncertain') {
          throw new Error('injected filesystem EIO with unknown effect');
        }
        return Promise.resolve();
      },
    };
    try {
      await runHistoricalDownloadAttempt(store, id, hooks);
    } catch {
      strictEqual(scenario, 'lost-completion');
      strictEqual(durable.get().status, 'intent');
      await runHistoricalDownloadAttempt(durable, id, hooks);
    }
    const actions: ServiceOwnedAction[] = [{
      id: 'plex:1',
      service: 'plex',
      targetId: '1',
      presence: 'current',
      entries: [{ id: 'file', path: '/library/fixture.mkv' }],
      effectsComplete: true,
    }];
    const plan = {
      actions,
      retention: planServiceOwnedRetention({
        actions,
        retainedEntries: [],
        evidenceRevision: 'fixture',
        qbInventory: 'unconfigured',
      }),
    };
    const attempts: Record<string, import('./serviceOwnedWorkflow.ts').ServiceOwnedAttempt> = {};
    let present = true;
    let serviceCalls = 0;
    const runtime = {
      save() {},
      revalidate: () => Promise.resolve(),
      present: () => Promise.resolve(present),
      mutate: (
        _action: ServiceOwnedAction,
        record: (r: { status: 'accepted'; httpStatus: number }) => void,
      ) => {
        serviceCalls++;
        present = false;
        record({ status: 'accepted', httpStatus: 200 });
        return Promise.resolve();
      },
    };
    await executeServiceOwnedActions(plan, attempts, runtime);
    await runHistoricalDownloadAttempt(durable, id, hooks);
    await executeServiceOwnedActions(plan, attempts, runtime);
    strictEqual(serviceCalls, 1);
    strictEqual(unlinks, scenario === 'intent' || scenario === 'skipped' ? 0 : 1);
    strictEqual(Object.keys(attempts).join(','), 'plex:1');
    strictEqual(
      durable.get().status,
      scenario === 'intent' || scenario === 'lost-completion' ? 'uncertain' : scenario,
    );
    const reserved = withTransaction((db) =>
      db.prepare('SELECT 1 FROM historical_download_reservations WHERE journal_id=?').value(id)
    );
    strictEqual(
      !!reserved,
      scenario === 'intent' || scenario === 'lost-completion' || scenario === 'uncertain',
    );
  }
  // Unknown optional evidence must not throw before the isolated journal boundary.
  // In particular, an old/invalid envelope cannot block otherwise valid service work.
  withTransaction((db) => {
    db.exec(
      'CREATE TABLE deletion_targets(operation_id TEXT, snapshot TEXT, ordinal INTEGER, status TEXT, id INTEGER PRIMARY KEY)',
    );
    db.prepare('INSERT INTO deletion_targets VALUES(?,?,0,?,1)').run(
      'success',
      JSON.stringify({ serviceOwnedPlan: {} }),
      'running',
    );
    db.prepare('UPDATE historical_download_journal SET status=?,evidence=? WHERE id=?').run(
      'pending',
      '{"version":2}',
      'success',
    );
  });
  await ensureHistoricalDownloadPhase(
    { operationId: 'success', serverId: 1 } as import('../core/types.ts').DeletionWorkTarget,
  );
  strictEqual(historicalDownloadJournalStore('success', 'shared:success').get().status, 'skipped');
  withTransaction((db) =>
    db.prepare('UPDATE historical_download_journal SET status=?,evidence=? WHERE id=?').run(
      'pending',
      JSON.stringify({
        version: 1,
        id: 'invalid-fingerprint',
        filesystem: { entry: 'shared:success' },
      }),
      'success',
    )
  );
  await ensureHistoricalDownloadPhase(
    { operationId: 'success', serverId: 1 } as import('../core/types.ts').DeletionWorkTarget,
  );
  strictEqual(historicalDownloadJournalStore('success', 'shared:success').get().status, 'skipped');
  // Old filesystem evidence is rejected inside validation; interrupted intents
  // still take the existing no-replay path before any validation or inventory.
  for (const status of ['pending', 'intent']) {
    const evidence = {
      version: 1,
      filesystem: { version: 1, entry: 'shared:success', device: 1, inode: 2 },
    };
    withTransaction((db) =>
      db.prepare('UPDATE historical_download_journal SET status=?,evidence=? WHERE id=?').run(
        status,
        JSON.stringify({ ...evidence, id: serviceOwnedFingerprint(evidence) }),
        'success',
      )
    );
    await ensureHistoricalDownloadPhase(
      { operationId: 'success', serverId: 1 } as import('../core/types.ts').DeletionWorkTarget,
    );
    const result = historicalDownloadJournalStore('success', 'shared:success').get();
    strictEqual(result.status, status === 'intent' ? 'uncertain' : 'skipped');
    strictEqual(
      result.reason?.includes(status === 'intent' ? 'never replayed' : 'fresh preview'),
      true,
    );
  }
  const exact = {
    version: 2,
    device: '44',
    inode: '649925721227816726',
    rootIdentity: '44:648799825613029714',
    parentIdentity: '44:649925725556681959',
  };
  const roundtrip = withTransaction((db) => {
    db.prepare('UPDATE historical_download_journal SET evidence=? WHERE id=?').run(
      JSON.stringify(exact),
      'success',
    );
    return JSON.parse(
      db.prepare('SELECT evidence FROM historical_download_journal WHERE id=?').value<[string]>(
        'success',
      )![0],
    );
  });
  strictEqual(roundtrip.inode, exact.inode);
  strictEqual(roundtrip.device, exact.device);
  strictEqual(roundtrip.rootIdentity, exact.rootIdentity);
  strictEqual(roundtrip.parentIdentity, exact.parentIdentity);
  strictEqual(serviceOwnedFingerprint(roundtrip), serviceOwnedFingerprint(exact));
  for (
    const change of [
      { inode: '649925721227816727' },
      { rootIdentity: '44:648799825613029715' },
      { parentIdentity: '44:649925725556681960' },
    ]
  ) {
    strictEqual(
      serviceOwnedFingerprint({ ...exact, ...change }) === serviceOwnedFingerprint(exact),
      false,
    );
  }
});
