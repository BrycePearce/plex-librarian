import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';

const directory = await Deno.makeTempDir();
const dbPath = resolve(directory, 'auth.db');
Deno.env.set('DB_PATH', dbPath);
Deno.env.delete('PLEX_URL');
Deno.env.delete('PLEX_TOKEN');
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(dbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { default: router } = await import('./route.ts');

function setActiveServer(active: boolean) {
  withTransaction((client) => {
    client.exec(`
      INSERT OR IGNORE INTO servers
        (id, machine_identifier, name, url, access_token, last_connected_at)
        VALUES (1, 'plex', 'Plex', 'http://plex', 'token', 1);
      INSERT INTO settings (id, client_id, active_server_id)
        VALUES (1, 'client', ${active ? 1 : 'NULL'})
        ON CONFLICT(id) DO UPDATE SET active_server_id = ${active ? 1 : 'NULL'};
    `);
  });
}

Deno.test('configuration checks return local state without contacting Plex', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Configuration must not contact Plex');
  };
  try {
    setActiveServer(true);
    assertEquals(await (await router.request('/status?validate=false')).json(), {
      configured: true,
      source: 'db',
    });
    setActiveServer(false);
    assertEquals(await (await router.request('/status?validate=false')).json(), {
      configured: false,
      source: null,
    });
    Deno.env.set('PLEX_URL', 'http://plex');
    assertEquals(await (await router.request('/status?validate=false')).json(), {
      configured: false,
      source: 'env',
      reason: 'env_incomplete',
    });
    Deno.env.set('PLEX_TOKEN', 'env-token');
    assertEquals(await (await router.request('/status?validate=false')).json(), {
      configured: true,
      source: 'env',
    });
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete('PLEX_URL');
    Deno.env.delete('PLEX_TOKEN');
  }
});

Deno.test('account validation still detects revoked tokens and tolerates outages', async () => {
  const originalFetch = globalThis.fetch;
  try {
    setActiveServer(true);
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    assertEquals(await (await router.request('/status')).json(), {
      configured: true,
      source: 'db',
      reachable: false,
    });
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 401 }));
    assertEquals(await (await router.request('/status')).json(), {
      configured: false,
      source: null,
      reason: 'token_revoked',
    });
    assertEquals(await (await router.request('/status?validate=false')).json(), {
      configured: false,
      source: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('a late revoked-token response does not disconnect refreshed credentials', async () => {
  const originalFetch = globalThis.fetch;
  const response = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  setActiveServer(true);
  globalThis.fetch = () => {
    started.resolve();
    return response.promise;
  };
  try {
    const pending = router.request('/status');
    await started.promise;
    withTransaction((client) => {
      client.exec("UPDATE servers SET access_token = 'new-token' WHERE id = 1");
    });
    response.resolve(new Response(null, { status: 401 }));
    assertEquals(await (await pending).json(), { configured: true, source: 'db' });
    assertEquals(await (await router.request('/status?validate=false')).json(), {
      configured: true,
      source: 'db',
    });
  } finally {
    response.resolve(new Response(null, { status: 401 }));
    globalThis.fetch = originalFetch;
  }
});
