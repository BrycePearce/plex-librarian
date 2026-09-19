import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';

const directory = await Deno.makeTempDir({ prefix: 'deletion-activity-' });
Deno.env.set('DB_PATH', resolve(directory, 'test.db'));
Deno.env.delete('PLEX_URL');
Deno.env.delete('PLEX_TOKEN');
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(Deno.env.get('DB_PATH')!, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { createApp } = await import('../../app.ts');
const { deletionActivity } = await import('./activity.ts');

withTransaction((client) => {
  for (const id of [1, 2]) {
    client.prepare(
      "INSERT INTO servers (id, machine_identifier, name, url, access_token, last_connected_at) VALUES (?, ?, 'Test', 'http://plex', 'token', 1)",
    ).run(id, `machine-${id}`);
    client.prepare(
      "INSERT INTO libraries (server_id, key, title, type, synced_at) VALUES (?, 'shows', 'Shows', 'show', 1)",
    ).run(id);
  }
  client.prepare("INSERT INTO settings (id, client_id, active_server_id) VALUES (1, 'test', 1)")
    .run();
});

function seed(id: string, serverId = 1, count = 1) {
  withTransaction((client) => {
    client.prepare(`INSERT INTO deletion_operations
      (id, client_request_id, request_hash, server_id, library_key, kind, target_count, created_at, updated_at)
      VALUES (?, ?, 'hash', ?, 'shows', 'whole_item', ?, 1, 1)`).run(id, id, serverId, count);
    for (let ordinal = 0; ordinal < count; ordinal++) {
      client.prepare(`INSERT INTO deletion_targets
        (operation_id, ordinal, target_kind, target_key, title, snapshot, created_at, updated_at)
        VALUES (?, ?, 'whole_item', ?, ?, ?, 1, 1)`).run(
        id,
        ordinal,
        `${ordinal}`,
        `Title ${ordinal}`,
        JSON.stringify({ serviceOwnedPlan: { policyVersion: 4 } }),
      );
    }
  });
}

Deno.test('Activity reads accepted durable work immediately, after reload, and through waiting and terminal states', async () => {
  seed('ongoing', 1, 50);
  seed('other-server', 2);
  const read = async () => {
    // A fresh app/request has no navigation or in-memory operation state.
    const response = await createApp().request(
      '/api/deletion-operations/activity?limit=20&offset=0',
    );
    assertEquals(response.status, 200);
    return await response.json();
  };
  const accepted = await read();
  assertEquals(accepted.operations.length, 1);
  assertEquals(accepted.operations[0].id, 'ongoing');
  assertEquals(accepted.operations[0].status, 'queued');
  assertEquals(accepted.operations[0].targetCount, 50);
  assertEquals(accepted.operations[0].titles.length, 3);
  assertEquals(await read(), accepted);
  for (
    const status of [
      'running',
      'waiting_retry',
      'completed',
      'completed_with_warning',
      'needs_attention',
      'cancelled',
    ]
  ) {
    withTransaction((client) => {
      client.prepare('UPDATE deletion_operations SET status = ? WHERE id = ?').run(
        status,
        'ongoing',
      );
      client.prepare('UPDATE deletion_targets SET status = ? WHERE operation_id = ?').run(
        status,
        'ongoing',
      );
    });
    const page = await read();
    assertEquals(page.operations.length, 1);
    assertEquals(page.operations[0].id, 'ongoing');
    assertEquals(page.operations[0].status, status);
    assertEquals(page.operations[0].waitingForServiceVerification, status === 'waiting_retry');
  }
  // No library items were seeded: their absence must never determine completion.
});

Deno.test('Activity bounds pages and puts old active work ahead of terminal history', () => {
  seed('queued');
  const first = deletionActivity(1, 1, 0);
  const second = deletionActivity(1, 1, 1);
  assertEquals(first.operations.map((o) => o.id), ['queued']);
  assertEquals(first.hasMore, true);
  assertEquals(second.operations.map((o) => o.id), ['ongoing']);
  assertEquals(second.hasMore, false);
  assertEquals(deletionActivity(2, 1, 0).operations.map((o) => o.id), ['other-server']);
});

Deno.test('completion deduplication preserves event cursors and historical events without durable records', async () => {
  withTransaction((client) => {
    for (const operationId of ['historical', 'ongoing', 'ongoing']) {
      client.prepare(
        "INSERT INTO events (server_id, type, payload, created_at) VALUES (1, 'deletion.completed', ?, 1)",
      ).run(JSON.stringify({ operationId }));
    }
    client.prepare(
      "INSERT INTO events (server_id, type, created_at) VALUES (1, 'sync.completed', 1)",
    ).run();
  });
  const app = createApp();
  const page = await (await app.request('/api/events?excludeDurableDeletions=true&limit=1')).json();
  assertEquals(page.events.map((e: { type: string }) => e.type), ['sync.completed']);
  const next = await (await app.request(
    `/api/events?excludeDurableDeletions=true&limit=1&before=${page.nextCursor}`,
  )).json();
  assertEquals(next.events[0].payload.operationId, 'historical');
  assertEquals(next.nextCursor, null);
  const unchanged = await (await app.request('/api/events')).json();
  assertEquals(unchanged.events.length, 4);
});
