import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { normalizeQbittorrentUrl, QbittorrentApiError, QbittorrentClient } from './client.ts';

Deno.test('normalizeQbittorrentUrl preserves a reverse-proxy base path', () => {
  assertEquals(
    normalizeQbittorrentUrl('https://media.example/qbit/api/v2/'),
    'https://media.example/qbit',
  );
});

Deno.test('normalizeQbittorrentUrl rejects credentials embedded in the URL', () => {
  assertThrows(
    () => normalizeQbittorrentUrl('http://admin:secret@qbit:8080'),
    Error,
    'must not include a username or password',
  );
});

Deno.test('client authenticates and maps torrent details without exposing tracker passkeys', async () => {
  const calls: string[] = [];
  const client = new QbittorrentClient('http://qbit:8080', 'user', 'pass', (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/app/version') && !new Headers(init?.headers).has('Cookie')) {
      return Promise.resolve(new Response('Forbidden', { status: 403 }));
    }
    if (url.endsWith('/auth/login')) {
      return Promise.resolve(new Response('Ok.', { headers: { 'Set-Cookie': 'SID=abc; path=/' } }));
    }
    if (url.includes('/torrents/info')) {
      return Promise.resolve(Response.json([{
        hash: 'ABC',
        name: 'Release',
        size: 12,
        uploaded: 24,
        ratio: 2,
        seeding_time: 30,
        completion_on: 40,
        content_path: '/downloads/Release',
        save_path: '/downloads',
        tracker: 'https://tracker.example/secret/passkey',
        state: 'uploading',
      }]));
    }
    return Promise.resolve(Response.json([{ name: 'Release/movie.mkv', size: 12 }]));
  });
  const torrent = await client.torrent('abc');
  assertEquals(torrent?.trackerHost, 'tracker.example');
  assertEquals(torrent?.fileCount, 1);
  assertEquals(torrent?.files, [{ path: 'Release/movie.mkv', size: 12 }]);
  assertEquals(torrent?.filesTruncated, false);
  assertEquals(calls.length, 4);
});

Deno.test('client supports qBittorrent authentication bypass without credentials', async () => {
  const calls: string[] = [];
  const client = new QbittorrentClient('http://qbit:8080', '', '', (input, init) => {
    const url = String(input);
    calls.push(url);
    assertEquals(new Headers(init?.headers).has('Cookie'), false);
    if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
    return Promise.resolve(Response.json([]));
  });

  assertEquals(await client.testConnection(), { version: 'v5.1.2' });
  assertEquals(await client.torrent('a'.repeat(40)), null);
  assertEquals(calls, [
    'http://qbit:8080/api/v2/app/version',
    'http://qbit:8080/api/v2/app/version',
    `http://qbit:8080/api/v2/torrents/info?hashes=${'a'.repeat(40)}`,
  ]);
});

Deno.test('client rejects failed authentication', async () => {
  const client = new QbittorrentClient(
    'http://qbit:8080',
    'bad',
    'bad',
    (input) =>
      Promise.resolve(
        String(input).endsWith('/app/version')
          ? new Response('Forbidden', { status: 403 })
          : new Response('Fails.', { status: 200 }),
      ),
  );
  await assertRejects(() => client.testConnection(), QbittorrentApiError);
});
