import { assert, assertEquals, assertRejects } from '@std/assert';
import { Database } from '@db/sqlite';
import type { DurableTargetSnapshot } from '../core/validation.ts';
import type { ServiceOwnedPlan } from '../../mediaDeletion/serviceOwnedPlanning.ts';
import {
  historicalDelegation,
  reconcileHistoricalDelegations,
} from './historicalDownloadDelegation.ts';
import type { ServiceOwnedAttempt } from './serviceOwnedWorkflow.ts';

Deno.env.set('DB_PATH', ':memory:');
const { executeServiceOwnedActions } = await import('./serviceOwnedWorkflow.ts');

function fixture(count = 1) {
  const path = '/downloads/season/file.mkv';
  const owner = { instanceId: 1, lineage: { source: '/completed/season/file.mkv' } };
  const evidence = { discovery: 1, path, ...owner };
  const plan = {
    qbSelected: true,
    actions: Array.from({ length: count }, (_, i) => ({
      id: `qb:${i}`,
      targetId: `job:${i}`,
      service: 'qb',
      instanceKey: `qb:${i}`,
      presence: 'current',
      effectsComplete: true,
      files: [{ path: '/payload/season/file.mkv', size: 7 }],
    })),
    retention: {
      decisions: Array.from({ length: count }, (_, i) => ({
        actionId: `qb:${i}`,
        targetId: `job:${i}`,
        service: 'qb',
        requested: true,
        state: 'delete_candidate',
      })),
    },
  } as ServiceOwnedPlan;
  const snapshot = { serviceOwnedPlan: plan } as DurableTargetSnapshot;
  const targets = [{ id: 1, snapshot }];
  const coverage = [{
    source: owner.lineage.source,
    path,
    instanceId: 1,
    service: 'qb' as const,
    actionIds: plan.actions.map((a) => a.id),
  }];
  const link = () => historicalDelegation(evidence, path, [owner], coverage, targets, [plan]);
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE historical_download_journal(
    id TEXT PRIMARY KEY,operation_id TEXT,evidence TEXT,validation TEXT,status TEXT,reason TEXT,finished_at INTEGER);
    CREATE TABLE deletion_targets(id INTEGER PRIMARY KEY,operation_id TEXT,snapshot TEXT);`);
  db.prepare('INSERT INTO deletion_targets VALUES(?,?,?)').run(
    1,
    'op',
    JSON.stringify(snapshot),
  );
  db.prepare('INSERT INTO historical_download_journal VALUES(?,?,?,?,?,?,NULL)').run(
    'file',
    'op',
    JSON.stringify(evidence),
    JSON.stringify(link()),
    'skipped',
    'Needs review',
  );
  const save = () => {
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE deletion_targets SET snapshot=?').run(JSON.stringify(snapshot));
      reconcileHistoricalDelegations(db, 'op');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const status = () =>
    db.prepare("SELECT status FROM historical_download_journal WHERE id='file'")
      .value<[string]>()![0];
  return { db, evidence, owner, path, coverage, plan, snapshot, targets, link, save, status };
}
const confirmed = (): ServiceOwnedAttempt => ({
  startedAt: 1,
  response: { status: 'accepted', httpStatus: 200 },
  outcome: { status: 'target_absent', observedAt: 2 },
});

Deno.test('delegation persists integer database target IDs and rejects malformed references', () => {
  for (const targetId of [1, '1', 'target', 0, -1, 1.5, null, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();
    try {
      const databaseId = f.db.prepare('SELECT id FROM deletion_targets').value<[number]>()![0];
      const persisted = JSON.parse(
        f.db.prepare('SELECT validation FROM historical_download_journal')
          .value<[string]>()![0],
      );
      assertEquals(databaseId, 1);
      assertEquals(persisted.actions[0].targetId, databaseId);
      persisted.actions[0].targetId = targetId;
      f.db.prepare('UPDATE historical_download_journal SET validation=?').run(
        JSON.stringify(persisted),
      );
      f.snapshot.serviceOwnedAttempts = { 'qb:0': confirmed() };
      f.save();
      assertEquals(f.status(), targetId === databaseId ? 'handled_by_qb' : 'skipped');
    } finally {
      f.db.close();
    }
  }
});

Deno.test('exact delegation refuses retained, held, incomplete, unrelated and mismatched paths', () => {
  for (
    const scenario of [
      'path',
      'owner',
      'action',
      'kept',
      'held',
      'unchecked',
      'incomplete',
      'retained',
      'upgrade',
    ]
  ) {
    const f = fixture();
    try {
      if (scenario === 'path') f.coverage[0].path += '.other';
      if (scenario === 'owner') f.coverage[0].instanceId = 2;
      if (scenario === 'action') f.coverage[0].actionIds = ['unrelated'];
      if (scenario === 'kept' || scenario === 'held') {
        f.plan.retention.decisions[0].state = scenario;
      }
      if (scenario === 'unchecked') f.plan.qbSelected = false;
      if (scenario === 'incomplete') f.plan.actions[0].effectsComplete = false;
      if (scenario === 'retained') f.plan.actions[0].retainedOwnership = true;
      if (scenario === 'upgrade') f.snapshot.upgradeHold = 'fixture';
      assertEquals(f.link(), undefined, scenario);
    } finally {
      f.db.close();
    }
  }
});

Deno.test('only confirmed exact QB outcomes reconcile; legacy and mixed warnings remain', () => {
  for (
    const scenario of [
      'confirmed',
      'pending',
      'accepted',
      'uncertain',
      'failed',
      'unrelated',
      'changed',
      'held',
      'legacy',
      'corrupt',
    ]
  ) {
    const f = fixture();
    try {
      const attempt = confirmed();
      if (scenario === 'accepted') delete attempt.outcome;
      if (scenario === 'uncertain') delete attempt.response;
      if (scenario === 'failed') attempt.failure = { httpStatus: 500 };
      f.snapshot.serviceOwnedAttempts = scenario === 'pending' ? {} : {
        [scenario === 'unrelated' ? 'unrelated' : 'qb:0']: attempt,
      };
      if (scenario === 'changed') f.plan.actions[0].files[0].path += '.new';
      if (scenario === 'held') f.plan.retention.decisions[0].state = 'held';
      if (scenario === 'legacy') {
        f.db.exec('UPDATE historical_download_journal SET validation=NULL');
      }
      if (scenario === 'corrupt') f.db.exec("UPDATE historical_download_journal SET evidence='{}'");
      f.db.prepare('INSERT INTO historical_download_journal VALUES(?,?,?,?,?,?,NULL)').run(
        'unresolved',
        'op',
        '{}',
        null,
        'changed',
        'changed',
      );
      f.save();
      assertEquals(f.status(), scenario === 'confirmed' ? 'handled_by_qb' : 'skipped', scenario);
      const warnings = f.db.prepare(
        "SELECT COUNT(*) FROM historical_download_journal WHERE status IN ('changed','skipped','failed','uncertain')",
      )
        .value<[number]>()![0];
      assertEquals(warnings, scenario === 'confirmed' ? 1 : 2);
      f.save(); // Durable accounting is idempotent and leaves legacy reasons intact.
      assertEquals(f.status(), scenario === 'confirmed' ? 'handled_by_qb' : 'skipped');
    } finally {
      f.db.close();
    }
  }
});

Deno.test('every covering action must confirm across serialized restart', () => {
  const f = fixture(2);
  try {
    f.snapshot.serviceOwnedAttempts = { 'qb:0': confirmed() };
    f.save();
    assertEquals(f.status(), 'skipped');
    const restored = JSON.parse(
      f.db.prepare('SELECT snapshot FROM deletion_targets').value<[string]>()![0],
    ) as DurableTargetSnapshot;
    restored.serviceOwnedAttempts!['qb:1'] = confirmed();
    Object.assign(f.snapshot, restored);
    f.save();
    assertEquals(f.status(), 'handled_by_qb');
  } finally {
    f.db.close();
  }
});

Deno.test('multiple target references and fresh action identity are preserved', () => {
  const f = fixture();
  try {
    const other = structuredClone(f.targets[0]);
    other.id = 2;
    f.targets.push(other);
    const link = f.link()!;
    assertEquals(link.actions.map((a) => a.targetId), [1, 2]);
    f.db.prepare('UPDATE historical_download_journal SET validation=?').run(JSON.stringify(link));
    f.db.prepare('INSERT INTO deletion_targets VALUES(?,?,?)').run(
      2,
      'op',
      JSON.stringify(other.snapshot),
    );
    f.snapshot.serviceOwnedAttempts = { 'qb:0': confirmed() };
    // Save just the first target; a sibling with no confirmed request stays unresolved.
    f.db.prepare('UPDATE deletion_targets SET snapshot=? WHERE id=1').run(
      JSON.stringify(f.snapshot),
    );
    reconcileHistoricalDelegations(f.db, 'op');
    assertEquals(f.status(), 'skipped');
    other.snapshot.serviceOwnedAttempts = { 'qb:0': confirmed() };
    f.db.prepare('UPDATE deletion_targets SET snapshot=? WHERE id=2').run(
      JSON.stringify(other.snapshot),
    );
    reconcileHistoricalDelegations(f.db, 'op');
    assertEquals(f.status(), 'handled_by_qb');
    const fresh = structuredClone(f.plan);
    fresh.actions[0].files[0].path += '.changed';
    assertEquals(
      historicalDelegation(f.evidence, f.path, [f.owner], f.coverage, f.targets, [fresh]),
      undefined,
    );
    assertEquals(
      historicalDelegation(
        f.evidence,
        f.path,
        [f.owner],
        [{ ...f.coverage[0], path: undefined }],
        f.targets,
        [f.plan],
      ),
      undefined,
    );
  } finally {
    f.db.close();
  }
});

Deno.test('real action loop acceptance remains unresolved until retry verifies absence without replay', async () => {
  const f = fixture();
  try {
    let present = true;
    let mutations = 0;
    const attempts: Record<string, ServiceOwnedAttempt> = {};
    f.snapshot.serviceOwnedAttempts = attempts;
    const runtime = {
      save: f.save,
      revalidate: () => Promise.resolve(),
      present: () => Promise.resolve(present),
      mutate: (
        _action: unknown,
        record: (response: { status: 'accepted'; httpStatus: number }) => void,
      ) => {
        mutations++;
        record({ status: 'accepted', httpStatus: 200 });
        assertEquals(f.status(), 'skipped');
        return Promise.resolve();
      },
    };
    await assertRejects(
      () => executeServiceOwnedActions(f.plan, attempts, runtime),
      Error,
      'waiting for inventory',
    );
    assertEquals(f.status(), 'skipped');
    present = false;
    const restored = JSON.parse(
      f.db.prepare('SELECT snapshot FROM deletion_targets').value<[string]>()![0],
    ) as DurableTargetSnapshot;
    f.snapshot.serviceOwnedAttempts = restored.serviceOwnedAttempts;
    await executeServiceOwnedActions(f.plan, f.snapshot.serviceOwnedAttempts!, runtime);
    assertEquals(f.status(), 'handled_by_qb');
    assertEquals(mutations, 1);
    assert(
      f.db.prepare(
        "SELECT CAST(finished_at AS REAL) FROM historical_download_journal WHERE id='file'",
      ).value<[number]>()![0] > 0,
    );
  } finally {
    f.db.close();
  }
});
