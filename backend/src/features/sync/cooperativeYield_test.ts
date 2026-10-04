import { Database } from '@db/sqlite';
import { assert, assertEquals } from '@std/assert';
import { createSyncYield } from './cooperativeYield.ts';

Deno.test('sync yields let pending request callbacks run between committed SQLite batches', async () => {
  const client = new Database(':memory:');
  client.exec('CREATE TABLE synced_rows (id INTEGER PRIMARY KEY)');
  const insert = client.prepare('INSERT INTO synced_rows VALUES (?)');
  const count = client.prepare('SELECT COUNT(*) FROM synced_rows');
  const yieldIfNeeded = createSyncYield(0);
  let rowsWhenRequestRan: number | undefined;
  const request = setTimeout(() => {
    rowsWhenRequestRan = count.value<[number]>()![0];
  }, 0);
  try {
    for (let batch = 0; batch < 3; batch++) {
      // The async proxy resolves only after native writes have completed.
      await Promise.resolve(
        client.transaction(() => {
          for (let row = 0; row < 500; row++) insert.run(batch * 500 + row);
        })(),
      );
      await yieldIfNeeded();
    }
    assertEquals(rowsWhenRequestRan, 500);
    assertEquals(count.value(), [1500]);
  } finally {
    clearTimeout(request);
    insert.finalize();
    count.finalize();
    client.close();
  }
});

Deno.test('sync default time budget yields after CPU work rather than only draining microtasks', async () => {
  const yieldIfNeeded = createSyncYield();
  let requestRan = false;
  const request = setTimeout(() => {
    requestRan = true;
  }, 0);
  try {
    const started = performance.now();
    while (performance.now() - started < 60) {
      // Stand in for synchronous SQLite work that exceeds the default budget.
    }
    await Promise.resolve();
    assertEquals(requestRan, false);
    await yieldIfNeeded();
    assert(requestRan);
  } finally {
    clearTimeout(request);
  }
});

Deno.test('short sync batches avoid scheduling a timer per write', async () => {
  const yieldIfNeeded = createSyncYield(60_000);
  let requestRan = false;
  const request = setTimeout(() => {
    requestRan = true;
  }, 0);
  try {
    for (let batch = 0; batch < 10; batch++) await yieldIfNeeded();
    assertEquals(requestRan, false);
  } finally {
    clearTimeout(request);
  }
});
