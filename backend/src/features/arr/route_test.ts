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
    INSERT INTO qbittorrent_instances
      (id, server_id, name, url, username, password, created_at, updated_at)
      VALUES (11, 1, 'qBittorrent', 'http://qbit:8080', '', '', 1, 1);
  `);
});

const { createApp } = await import('../../app.ts');
const app = createApp();
const originalFetch = globalThis.fetch;

Deno.test('storage verification validates instance ownership and allows an unavailable sample', async () => {
  const request = (body: unknown) =>
    app.request('/api/integrations/arr/verify-storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const paths = [
    { kind: 'library', arrPath: '/tv', localPath: '/media' },
    { kind: 'download', arrPath: '/downloads', localPath: '/downloads' },
  ];
  const body = { instanceId: 7, url: 'http://sonarr:8989', pathMappings: paths, libraryKeys: [] };
  assertEquals((await request({ ...body, instanceId: 9, url: 'http://foreign:8989' })).status, 404);
  assertEquals((await request({ ...body, libraryKeys: ['foreign-library'] })).status, 400);
  assertEquals(
    (await request({
      ...body,
      pathMappings: [{ kind: 'library', arrPath: '/tv', localPath: '../unsafe' }],
    })).status,
    400,
  );
  assertEquals((await request({ ...body, url: 'http://different' })).status, 400);
  const response = await request(body);
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.status, 'unverified');
  assertStringIncludes(result.reason, 'sync the library');
  assertEquals(JSON.stringify(result).includes('stored-sonarr-key'), false);
});

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

Deno.test('connected qBittorrent storage paths are bounded and sanitized', async () => {
  try {
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
      if (url.endsWith('/app/preferences')) {
        return Promise.resolve(Response.json({ save_path: '/data/.torrents/complete' }));
      }
      if (url.endsWith('/torrents/categories')) {
        return Promise.resolve(Response.json({
          tv: { savePath: '/data/.torrents/complete' },
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    const response = await app.request('/api/integrations/qbittorrent/storage-paths');
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { paths: ['/data/.torrents/complete'] });

    withTransaction((client) =>
      client.exec(`
        INSERT INTO qbittorrent_instances
          (id, server_id, name, url, username, password, created_at, updated_at)
          VALUES (12, 1, 'Unavailable', 'http://qbit-unavailable:8080', '', '', 1, 1)
      `)
    );
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('qbit-unavailable')) {
        return Promise.resolve(new Response('unavailable', { status: 500 }));
      }
      if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
      if (url.endsWith('/app/preferences')) {
        return Promise.resolve(Response.json({ save_path: '/data/.torrents/complete' }));
      }
      return Promise.resolve(Response.json({}));
    }) as typeof fetch;
    const partial = await app.request('/api/integrations/qbittorrent/storage-paths');
    assertEquals(partial.status, 502);
    withTransaction((client) => client.exec('DELETE FROM qbittorrent_instances WHERE id = 12'));

    globalThis.fetch = (() =>
      Promise.resolve(new Response('secret body', { status: 500 }))) as typeof fetch;
    const failed = await app.request('/api/integrations/qbittorrent/storage-paths');
    assertEquals(failed.status, 502);
    const body = await failed.text();
    assertEquals(body.includes('secret body'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('deletion-time path saving preserves credentials and per-library preferences', async () => {
  withTransaction((client) => {
    client.exec(`
      INSERT INTO libraries (server_id, key, title, type, synced_at)
        VALUES (1, 'access-tv-a', 'TV A', 'show', 1), (1, 'access-tv-b', 'TV B', 'show', 1);
      INSERT INTO arr_library_mappings (server_id, library_key, arr_instance_id, add_import_exclusion)
        VALUES (1, 'access-tv-a', 7, 0), (1, 'access-tv-b', 7, 1);
    `);
  });
  const request = (id: number, body: unknown) =>
    app.request(`/api/integrations/arr/instances/${id}/path-mappings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const body = { pathMappings: [{ kind: 'library', arrPath: '/tv', localPath: '/media' }] };
  assertEquals((await request(9, body)).status, 404);
  assertEquals((await request(7, { ...body, url: 'http://other' })).status, 400);
  assertEquals((await request(7, body)).status, 200);
  withTransaction((client) => {
    assertEquals(client.prepare('SELECT url, api_key FROM arr_instances WHERE id = 7').value(), [
      'http://sonarr:8989',
      'stored-sonarr-key',
    ]);
    assertEquals(
      client.prepare(
        'SELECT add_import_exclusion FROM arr_library_mappings WHERE arr_instance_id = 7 ORDER BY library_key',
      ).values(),
      [[0], [1]],
    );
    assertEquals(
      client.prepare(
        'SELECT kind, arr_path, local_path FROM arr_path_mappings WHERE arr_instance_id = 7',
      ).values(),
      [['library', '/tv', '/media']],
    );
  });
});

Deno.test('selected-title storage verification rejects foreign and stale selection instead of sampling another title', async () => {
  const request = (body: unknown) =>
    app.request('/api/integrations/arr/verify-storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const body = {
    instanceId: 7,
    url: 'http://sonarr:8989',
    pathMappings: [{ kind: 'library', arrPath: '/tv', localPath: '/media' }],
    libraryKeys: ['access-tv-a'],
    ratingKey: 'missing-title',
  };
  assertEquals((await request(body)).status, 404);
  assertEquals((await request({ ...body, ratingKey: 123 })).status, 400);
  assertEquals((await request({ ...body, selectedPath: '/tv/../unsafe' })).status, 400);
  assertEquals(
    (await request({ ...body, ratingKey: undefined, selectedPath: '/tv/file.mkv' })).status,
    400,
  );
});

Deno.test('qBittorrent mapping correction validates a current sample and increments revision without deleting the mapping', async () => {
  const firstRoot = await Deno.makeTempDir();
  const secondRoot = await Deno.makeTempDir();
  try {
    const firstFile = resolve(firstRoot, 'selected.mkv');
    const secondFile = resolve(secondRoot, 'selected.mkv');
    await Deno.writeTextFile(firstFile, 'test');
    await Deno.writeTextFile(secondFile, 'test');
    const request = (path: string, method: string, body: unknown) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const body = {
      instanceKey: 'db:11',
      qbittorrentPath: '/downloads',
      localPath: firstRoot,
      caseSensitive: true,
      validationQbittorrentPath: '/downloads/selected.mkv',
      validationLocalPath: firstFile,
      validationSize: 4,
    };
    const created = await request('/api/integrations/qbittorrent/path-mappings', 'POST', body);
    assertEquals(created.status, 201, await created.clone().text());
    const mapping = await created.json();
    const updated = await request(
      `/api/integrations/qbittorrent/path-mappings/${mapping.id}`,
      'PUT',
      {
        ...body,
        localPath: secondRoot,
        validationLocalPath: secondFile,
      },
    );
    assertEquals(updated.status, 200, await updated.clone().text());
    assertEquals((await updated.json()).revision, 2);
    assertEquals(
      (await request(`/api/integrations/qbittorrent/path-mappings/${mapping.id}`, 'PUT', {
        ...body,
        validationSize: 99,
      })).status,
      409,
    );
    assertEquals(
      (await request(`/api/integrations/qbittorrent/path-mappings/${mapping.id}`, 'PUT', {
        ...body,
        instanceKey: 'db:999',
      })).status,
      404,
    );
    withTransaction((client) => {
      assertEquals(
        client.prepare('SELECT revision FROM qbittorrent_path_mappings WHERE id = ?').value(
          mapping.id,
        ),
        [2],
      );
    });
  } finally {
    await Deno.remove(firstRoot, { recursive: true });
    await Deno.remove(secondRoot, { recursive: true });
  }
});
