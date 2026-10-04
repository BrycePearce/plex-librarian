import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';
import type { IntegrationCompatibilityResponse } from '@plex-librarian/shared/types.ts';

const directory = await Deno.makeTempDir();
const dbPath = resolve(directory, 'compatibility.db');
Deno.env.set('DB_PATH', dbPath);
for (
  const name of [
    'PLEX_URL',
    'PLEX_TOKEN',
    'QBITTORRENT_URL',
    'QBITTORRENT_USERNAME',
    'QBITTORRENT_PASSWORD',
  ]
) {
  Deno.env.delete(name);
}
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(dbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { clearPlexClientCache } = await import('../../integrations/plex/client.ts');
const { createApp } = await import('../../app.ts');
const app = createApp();

withTransaction((client) => {
  client.exec(`
    INSERT INTO servers (id, machine_identifier, name, url, access_token, last_connected_at)
      VALUES (1, 'active', 'Active', 'http://plex', 'token', 1),
             (2, 'other', 'Other', 'http://plex-other', 'token-other', 1);
    INSERT INTO settings (id, client_id, active_server_id) VALUES (1, 'client', 1)
      ON CONFLICT(id) DO UPDATE SET active_server_id = 1;
    INSERT INTO arr_instances (id, server_id, type, name, url, api_key, created_at, updated_at)
      VALUES (1, 1, 'sonarr', 'Sonarr', 'http://sonarr', 'old-key', 1, 1),
             (2, 2, 'sonarr', 'Other Sonarr', 'http://other-sonarr', 'other-key', 1, 1);
    INSERT INTO qbittorrent_instances (id, server_id, name, url, username, password, created_at, updated_at)
      VALUES (1, 1, 'QB', 'http://qbit', '', '', 1, 1);
    INSERT INTO seerr_instances (id, server_id, name, url, api_key, created_at, updated_at)
      VALUES (1, 1, 'Seerr', 'http://seerr', 'seerr-key', 1, 1);
  `);
});

Deno.test('compatibility requests reuse probes, follow exact config changes, and honor fresh tests', async () => {
  const originalFetch = globalThis.fetch;
  const calls = new Map<string, number>();
  let failSeerr = false;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.set(url.hostname, (calls.get(url.hostname) ?? 0) + 1);
    if (url.hostname === 'seerr' && failSeerr) {
      return Promise.resolve(new Response('', { status: 503 }));
    }
    if (url.pathname.endsWith('/system/status')) {
      return Promise.resolve(Response.json({ appName: 'Sonarr', version: '4.0.19.2979' }));
    }
    if (url.pathname.endsWith('/app/version')) return Promise.resolve(new Response('v5.2.0'));
    if (url.pathname.endsWith('/app/webapiVersion')) return Promise.resolve(new Response('2.14.1'));
    if (url.pathname.endsWith('/torrents/info')) return Promise.resolve(Response.json([]));
    if (url.pathname.endsWith('/status')) {
      return Promise.resolve(Response.json({ version: '3.4.1' }));
    }
    if (url.pathname.endsWith('/request')) {
      return Promise.resolve(Response.json({ pageInfo: {}, results: [] }));
    }
    throw new Error(`Unexpected probe path ${url.pathname}`);
  }) as typeof fetch;
  const read = async () => {
    const response = await app.request('/api/integrations/compatibility');
    assertEquals(response.status, 200);
    return await response.json() as IntegrationCompatibilityResponse;
  };
  try {
    const [first, concurrent] = await Promise.all([read(), read()]);
    assertEquals(first, concurrent);
    assertEquals(first.checks.length, 3);
    const initialCalls = new Map(calls);
    assertEquals(await read(), first);
    assertEquals(calls, initialCalls);

    // The revision timestamp deliberately stays identical; exact credentials must matter.
    withTransaction((client) =>
      client.exec("UPDATE arr_instances SET api_key = 'new-key', name = 'Renamed' WHERE id = 1")
    );
    const changed = await read();
    assertEquals(changed.checks.find((check) => check.key === 'sonarr:1')?.name, 'Renamed');
    assertEquals(calls.get('sonarr'), 2);
    assertEquals(calls.get('qbit'), initialCalls.get('qbit'));
    assertEquals(calls.get('seerr'), initialCalls.get('seerr'));

    for (const [kind, host] of [['arr', 'sonarr'], ['qbittorrent', 'qbit'], ['seerr', 'seerr']]) {
      const before = calls.get(host)!;
      const response = await app.request(`/api/integrations/${kind}/instances/1/test`, {
        method: 'POST',
      });
      assertEquals(response.status, 200);
      const afterTest = calls.get(host)!;
      assertEquals(afterTest > before, true);
      await read();
      assertEquals(calls.get(host)! > afterTest, true);
    }
    // A failed explicit test invalidates an older healthy badge too.
    failSeerr = true;
    assertEquals(
      (await app.request('/api/integrations/seerr/instances/1/test', { method: 'POST' })).status,
      502,
    );
    assertEquals(
      (await read()).checks.find((check) => check.key === 'seerr:1')?.status,
      'unreachable',
    );

    Deno.env.set('QBITTORRENT_URL', 'http://env-qbit');
    const beforeStored = calls.get('qbit');
    const env = await read();
    assertEquals(env.checks.some((check) => check.key === 'qbittorrent:1'), false);
    assertEquals(env.checks.some((check) => check.key === 'qbittorrent:env'), true);
    const beforeEnv = calls.get('env-qbit')!;
    Deno.env.set('QBITTORRENT_PASSWORD', 'changed-password');
    await read();
    assertEquals(calls.get('env-qbit')! > beforeEnv, true);
    assertEquals(calls.get('qbit'), beforeStored);

    withTransaction((client) => client.exec('DELETE FROM arr_instances WHERE id = 1'));
    assertEquals((await read()).checks.some((check) => check.kind === 'sonarr'), false);
    withTransaction((client) =>
      client.exec('UPDATE settings SET active_server_id = 2 WHERE id = 1')
    );
    clearPlexClientCache();
    const other = await read();
    assertEquals(other.checks.some((check) => check.key === 'sonarr:2'), true);
    assertEquals(other.checks.some((check) => check.key === 'seerr:1'), false);
    assertEquals(calls.get('other-sonarr'), 1);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete('QBITTORRENT_URL');
    Deno.env.delete('QBITTORRENT_PASSWORD');
    clearPlexClientCache();
  }
});
