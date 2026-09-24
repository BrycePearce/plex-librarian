import { rejects, strictEqual } from 'node:assert';
import {
  type HistoricalDownloadAttempt,
  runHistoricalDownloadAttempt,
} from './historicalDownloadJournal.ts';
import { HistoricalDownloadCheckpoint } from '../../mediaDeletion/historicalDownloadCheckpoint.ts';

Deno.test('optional journal isolates failures, persists intent, and never replays terminal or interrupted entries', async () => {
  let row: HistoricalDownloadAttempt = {
    version: 1,
    id: 'one',
    entry: 'physical-parent:file',
    status: 'pending',
  };
  let unlinks = 0;
  let services = 0;
  const store = {
    get: () => structuredClone(row),
    save: (next: HistoricalDownloadAttempt) => {
      row = next;
    },
  };
  const hooks = {
    cancelled: () => false,
    validate: () => Promise.resolve('ready' as const),
    unlink: () => {
      strictEqual(row.status, 'intent');
      unlinks++;
      throw new Deno.errors.PermissionDenied('injected EACCES');
    },
  };
  await runHistoricalDownloadAttempt(store, 'one', hooks);
  services++;
  strictEqual(row.status, 'failed');
  strictEqual(services, 1);
  await runHistoricalDownloadAttempt(store, 'one', hooks);
  strictEqual(unlinks, 1);
  row.status = 'intent';
  await runHistoricalDownloadAttempt(store, 'one', hooks);
  strictEqual(row.status, 'uncertain');
  strictEqual(unlinks, 1);
  row.status = 'pending';
  await runHistoricalDownloadAttempt(store, 'one', { ...hooks, cancelled: () => true });
  strictEqual(row.status, 'skipped');
  strictEqual(unlinks, 1);
  row.status = 'pending';
  await runHistoricalDownloadAttempt(store, 'one', {
    ...hooks,
    validate: () => Promise.reject(new Error('owners unreadable')),
  });
  strictEqual(row.status, 'skipped');
  strictEqual(unlinks, 1);
});

Deno.test('completion persistence failure retains uncertain intent and cannot adopt a recreated path', async () => {
  let row: HistoricalDownloadAttempt = {
    version: 1,
    id: 'one',
    entry: 'parent:name',
    status: 'pending',
  };
  let unlinks = 0;
  const store = {
    get: () => row,
    save: (next: HistoricalDownloadAttempt) => {
      if (next.status === 'success') throw new Error('simulated crash after unlink');
      row = next;
    },
  };
  const hooks = {
    cancelled: () => false,
    validate: () => Promise.resolve('ready' as const),
    unlink: () => {
      unlinks++;
      return Promise.resolve();
    },
  };
  await rejects(() => runHistoricalDownloadAttempt(store, 'one', hooks));
  strictEqual(row.status, 'intent');
  await runHistoricalDownloadAttempt(store, 'one', hooks);
  strictEqual(row.status, 'uncertain');
  strictEqual(unlinks, 1);
});

Deno.test('specific verification reasons persist without unlinking or replaying', async () => {
  for (const status of ['changed', 'skipped', 'already_absent'] as const) {
    let row: HistoricalDownloadAttempt = {
      version: 1,
      id: 'one',
      entry: 'parent:file',
      status: 'pending',
    };
    let validations = 0;
    let unlinks = 0;
    const store = {
      get: () => row,
      save: (next: HistoricalDownloadAttempt) => {
        row = next;
      },
    };
    const hooks = {
      cancelled: () => false,
      validate: () => {
        validations++;
        return Promise.resolve({ status, reason: 'A current download job owns this file' });
      },
      unlink: () => {
        unlinks++;
        return Promise.resolve();
      },
    };
    await runHistoricalDownloadAttempt(store, 'one', hooks);
    await runHistoricalDownloadAttempt(store, 'one', hooks);
    strictEqual(row.status, status);
    strictEqual(row.reason, 'A current download job owns this file');
    strictEqual(validations, 1);
    strictEqual(unlinks, 0);
  }
});

Deno.test('job inventories are shared for ten evaluations regardless of service latency', async () => {
  let reads = 0;
  let wall = 10000;
  const checkpoint = new HistoricalDownloadCheckpoint(() => {
    wall += 2100;
    return Promise.resolve(++reads);
  }, () => wall);
  for (let file = 0; file < 22; file++) {
    strictEqual(await checkpoint.fresh(), Math.floor(file / 10) + 1);
    strictEqual(checkpoint.isFresh(), true);
    checkpoint.evaluated();
  }
  strictEqual(reads, 3);
  strictEqual(checkpoint.observation()?.evaluation, 3);
});

Deno.test('a failed refresh clears earlier authority and cannot restart through invalidation', async () => {
  let reads = 0;
  const checkpoint = new HistoricalDownloadCheckpoint(() => {
    if (++reads === 1) return Promise.resolve('owners');
    throw new Error('current inventory unavailable');
  });
  await checkpoint.fresh();
  for (let file = 0; file < 10; file++) checkpoint.evaluated();
  for (let file = 0; file < 22; file++) {
    await rejects(() => checkpoint.fresh(), /current inventory unavailable/);
  }
  checkpoint.invalidate();
  await rejects(() => checkpoint.fresh(), /current inventory unavailable/);
  strictEqual(reads, 2);
  strictEqual(checkpoint.isFresh(), false);
  strictEqual(checkpoint.observation(), null);
});

Deno.test('concurrent checkpoint callers share both successful and failed inventories', async () => {
  let reads = 0;
  const checkpoint = new HistoricalDownloadCheckpoint(() => {
    reads++;
    return Promise.reject(new Error('unknown ownership'));
  });
  const results = await Promise.allSettled([checkpoint.fresh(), checkpoint.fresh()]);
  strictEqual(results.every((result) => result.status === 'rejected'), true);
  strictEqual(reads, 1);
  strictEqual(checkpoint.isFresh(), false);
  let successes = 0;
  const valid = new HistoricalDownloadCheckpoint(() => Promise.resolve(++successes));
  strictEqual((await Promise.all([valid.fresh(), valid.fresh()])).join(','), '1,1');
});
