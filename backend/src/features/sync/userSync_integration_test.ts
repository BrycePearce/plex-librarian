import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';

const testDirectory = await Deno.makeTempDir();
const testDbPath = resolve(testDirectory, 'user-sync.db');
Deno.env.set('DB_PATH', testDbPath);

let friendPresent = true;
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === 'plex.tv' && url.pathname === '/api/v2/user') {
    return Promise.resolve(Response.json({ id: 100, username: 'owner' }));
  }
  if (url.hostname === 'plex.tv' && url.pathname === '/api/users') {
    return Promise.resolve(
      new Response(
        friendPresent
          ? `<MediaContainer size="1">
             <User id="200" username="friend">
               <Server id="12" machineIdentifier="machine-1"/>
             </User>
           </MediaContainer>`
          : '<MediaContainer size="0"/>',
      ),
    );
  }
  if (url.pathname === '/accounts') {
    const accounts = [
      { id: 0, name: 'System' },
      { id: 1, name: 'Owner' },
      ...(friendPresent ? [{ id: 200, name: 'Friend' }] : []),
    ];
    return Promise.resolve(Response.json({
      MediaContainer: { size: accounts.length, Account: accounts },
    }));
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}) as typeof fetch;

const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(testDbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { resolveActiveServer } = await import('../../integrations/plex/index.ts');
const { syncUsers } = await import('./userSync.ts');

withTransaction((client) => {
  client.prepare(
    `INSERT INTO servers
       (id, machine_identifier, name, url, access_token, last_connected_at)
     VALUES (1, 'machine-1', 'Test Plex', 'http://plex', 'token', 1)`,
  ).run();
  client.prepare(
    "INSERT INTO settings (id, client_id, active_server_id) VALUES (1, 'test', 1)",
  ).run();
});

Deno.test({
  name: 'same-second authoritative reconciliation prunes a removed account',
  async fn() {
    try {
      const active = await resolveActiveServer();
      await syncUsers(active.client, active.serverId, 100);
      assertEquals(
        withTransaction((client) =>
          client.prepare('SELECT account_id FROM users ORDER BY account_id').values()
        ),
        [[100], [200]],
      );

      friendPresent = false;
      await syncUsers(active.client, active.serverId, 100);

      assertEquals(
        withTransaction((client) =>
          client.prepare('SELECT account_id FROM users ORDER BY account_id').values()
        ),
        [[100]],
      );
      assertEquals(
        withTransaction((client) =>
          client.prepare('SELECT users_synced_at FROM servers WHERE id = 1').values()
        ),
        [[100]],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
