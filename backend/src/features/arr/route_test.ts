import { assertEquals, assertStringIncludes } from '@std/assert';
import { resolve } from '@std/path';
import type { ArrRootFoldersResponse } from '@plex-librarian/shared/types.ts';

const directory = await Deno.makeTempDir();
const dbPath = resolve(directory, 'arr-root-folders.db');
Deno.env.set('DB_PATH', dbPath);
Deno.env.delete('PLEX_URL');
Deno.env.delete('PLEX_TOKEN');
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(dbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');

withTransaction((client) => {
  client.exec(`
    INSERT INTO servers (id, machine_identifier, name, url, access_token, last_connected_at)
      VALUES (1, 'active', 'Active', 'http://plex', 'token', 1),
             (2, 'foreign', 'Foreign', 'http://plex', 'token', 1);
    INSERT INTO settings (id, client_id, active_server_id) VALUES (1, 'client', 1)
      ON CONFLICT(id) DO UPDATE SET active_server_id = 1;
    INSERT INTO arr_instances
      (id, server_id, type, name, url, api_key, created_at, updated_at)
      VALUES (7, 1, 'sonarr', 'Sonarr', 'http://sonarr:8989', 'stored-sonarr-key', 1, 1),
             (8, 1, 'radarr', 'Radarr', 'http://radarr:7878', 'stored-radarr-key', 1, 1),
             (9, 2, 'sonarr', 'Foreign', 'http://foreign:8989', 'foreign-key', 1, 1);
  `);
});

const { createApp } = await import('../../app.ts');
const app = createApp();
const originalFetch = globalThis.fetch;

async function discover(body: unknown): Promise<Response> {
  return await app.request('/api/integrations/arr/root-folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

Deno.test('Arr root-folder discovery validates credentials, ownership, and sanitizes output', async (t) => {
  try {
    await t.step('new Sonarr and Radarr connections use replacement credentials', async () => {
      for (const type of ['sonarr', 'radarr'] as const) {
        let request: { url: string; key: string } | undefined;
        globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
          request = {
            url: String(input),
            key: new Headers(init?.headers).get('X-Api-Key') ?? '',
          };
          return Promise.resolve(Response.json([{ id: 1, path: `/${type}` }]));
        }) as typeof fetch;
        const response = await discover({ type, url: `http://${type}/api/v3/`, apiKey: 'new-key' });
        assertEquals(response.status, 200);
        assertEquals(await response.json(), { roots: [`/${type}`] });
        assertEquals(request, { url: `http://${type}/api/v3/rootfolder`, key: 'new-key' });
      }
    });

    await t.step('owned instances use the stored normalized URL and key together', async () => {
      let request: { url: string; key: string } | undefined;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        request = {
          url: String(input),
          key: new Headers(init?.headers).get('X-Api-Key') ?? '',
        };
        return Promise.resolve(Response.json([{ id: 1, path: '/data/TV' }]));
      }) as typeof fetch;
      const response = await discover({ instanceId: 7, url: 'http://sonarr:8989/' });
      assertEquals(response.status, 200);
      assertEquals(request, {
        url: 'http://sonarr:8989/api/v3/rootfolder',
        key: 'stored-sonarr-key',
      });
    });

    await t.step('an edited URL is allowed only with a nonblank replacement key', async () => {
      let calls = 0;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        calls++;
        assertEquals(String(input), 'http://replacement:8990/api/v3/rootfolder');
        assertEquals(new Headers(init?.headers).get('X-Api-Key'), 'replacement-key');
        return Promise.resolve(Response.json([{ id: 1, path: '/replacement' }]));
      }) as typeof fetch;
      const accepted = await discover({
        instanceId: 7,
        url: 'http://replacement:8990',
        apiKey: ' replacement-key ',
      });
      assertEquals(accepted.status, 200);
      assertEquals(calls, 1);

      for (const apiKey of [undefined, '', '   ']) {
        const body = apiKey === undefined
          ? { instanceId: 7, url: 'http://edited:8990' }
          : { instanceId: 7, url: 'http://edited:8990', apiKey };
        assertEquals((await discover(body)).status, 400);
      }
      assertEquals(calls, 1);
    });

    await t.step('wrong-server and ambiguous or invalid requests are rejected', async () => {
      assertEquals((await discover({ instanceId: 9, url: 'http://foreign:8989' })).status, 404);
      for (
        const body of [
          null,
          {},
          { type: 'sonarr', instanceId: 7, url: 'http://sonarr', apiKey: 'key' },
          { type: 'lidarr', url: 'http://lidarr', apiKey: 'key' },
          { type: 'sonarr', url: 'file:///tmp/sonarr', apiKey: 'key' },
          { type: 'sonarr', url: 'http://sonarr', apiKey: '' },
          { instanceId: 7, url: 'http://sonarr:8989', extra: true },
        ]
      ) assertEquals((await discover(body)).status, 400);
    });

    await t.step('the boundary trims, filters, and exact-deduplicates in Arr order', async () => {
      globalThis.fetch = (() =>
        Promise.resolve(Response.json([
          { id: 1, path: ' /data/TV ' },
          { id: 2, path: '/data/Anime' },
          { id: 3, path: '/data/TV' },
          { id: 4, path: '/data/TV/' },
          { id: 5, path: 'relative' },
          { id: 6, path: '/' },
          { id: 7, path: 'C:\\Movies' },
        ]))) as typeof fetch;
      const response = await discover({ instanceId: 8, url: 'http://radarr:7878', apiKey: '' });
      assertEquals(response.status, 200);
      assertEquals(await response.json() as ArrRootFoldersResponse, {
        roots: ['/data/TV', '/data/Anime', '/data/TV/', 'C:\\Movies'],
      });
    });

    await t.step('upstream failures expose only the stable generic error', async () => {
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response('upstream body with stored-sonarr-key', { status: 500 }),
        )) as typeof fetch;
      const response = await discover({ instanceId: 7, url: 'http://sonarr:8989' });
      assertEquals(response.status, 502);
      const text = await response.text();
      assertEquals(text, '{"error":"could not load root-folder suggestions"}');
      assertEquals(text.includes('stored-sonarr-key'), false);
      assertEquals(text.includes('upstream body'), false);
      assertEquals(text.includes('sonarr:8989'), false);
      assertStringIncludes(text, 'could not load root-folder suggestions');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
