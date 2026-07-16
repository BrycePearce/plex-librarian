import { assertEquals, assertThrows } from '@std/assert';
import { QbittorrentDownloadClient } from './adapter.ts';
import { QbittorrentClient } from './client.ts';

const hash = 'a'.repeat(40);

function client(requests: string[]): QbittorrentDownloadClient {
  return new QbittorrentDownloadClient(
    new QbittorrentClient(
      'http://qbit:8080',
      '',
      '',
      ((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
        if (url.includes('/torrents/info')) {
          return Promise.resolve(Response.json(
            requests.length > 0 ? [] : [{
              hash,
              name: 'Release',
              content_path: '/downloads/release',
              save_path: '/downloads',
              size: 100,
            }],
          ));
        }
        if (url.includes('/torrents/files')) {
          return Promise.resolve(Response.json([{ name: 'release/movie.mkv', size: 100 }]));
        }
        if (url.endsWith('/torrents/delete')) {
          requests.push(String(init?.body));
          return Promise.resolve(new Response());
        }
        return Promise.resolve(Response.json([]));
      }) as typeof fetch,
    ),
  );
}

Deno.test('qBittorrent adapter normalizes hashes to opaque download job IDs', async () => {
  const job = await client([]).findJob(hash);
  assertEquals(job?.id, hash);
  assertEquals(job?.manifestFiles, [{ path: 'release/movie.mkv', size: 100 }]);
});

Deno.test('qBittorrent adapter requires explicit data deletion', () => {
  const adapter = client([]);
  assertThrows(
    () => adapter.deleteJob(hash, { deleteData: false }),
    Error,
    'explicit payload deletion',
  );
});

Deno.test('qBittorrent adapter delegates verified job and payload deletion', async () => {
  const requests: string[] = [];
  await client(requests).deleteJob(hash, { deleteData: true });
  assertEquals(requests, [`hashes=${hash}&deleteFiles=true`]);
});
