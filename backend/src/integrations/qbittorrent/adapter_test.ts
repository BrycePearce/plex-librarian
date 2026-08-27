import { assertEquals, assertRejects, assertThrows } from '@std/assert';
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
              content_path: '/downloads/release/movie.mkv',
              save_path: '/downloads',
              size: 100,
              total_size: 100,
            }],
          ));
        }
        if (url.includes('/torrents/files')) {
          return Promise.resolve(
            Response.json([{ index: 0, name: 'release/movie.mkv', size: 100 }]),
          );
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

Deno.test('qBittorrent discovery fingerprints stable ownership summaries', async () => {
  const discovered = await client([]).discoverJobs([{
    path: '/downloads/release/movie.mkv',
    caseSensitive: true,
  }]);
  assertEquals(discovered.jobs.map((job) => job.id), [hash]);
  assertEquals(/^[a-f0-9]{64}$/.test(discovered.summaryFingerprint), true);
});

Deno.test('qBittorrent discovery prefilters equal and descendant paths without a file count', async () => {
  const equalHash = '1'.repeat(40);
  const descendantHash = '2'.repeat(40);
  const unrelatedHash = '3'.repeat(40);
  const manifestReads: string[] = [];
  const summaries = [
    {
      hash: equalHash,
      content_path: '/downloads/movie.mkv',
      save_path: '/downloads',
      size: 100,
      total_size: 100,
    },
    {
      hash: descendantHash,
      content_path: '/downloads/show',
      save_path: '/downloads',
      size: 200,
      total_size: 200,
    },
    {
      hash: unrelatedHash,
      content_path: '/downloads/other',
      save_path: '/downloads',
      size: 300,
      total_size: 300,
    },
  ];
  const adapter = new QbittorrentDownloadClient(
    new QbittorrentClient(
      'http://qbit:8080',
      '',
      '',
      ((input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.1'));
        if (url.pathname.endsWith('/torrents/files')) {
          const requestedHash = url.searchParams.get('hash')!;
          manifestReads.push(requestedHash);
          return Promise.resolve(
            Response.json(
              requestedHash === equalHash ? [{ index: 0, name: 'movie.mkv', size: 100 }] : [
                { index: 0, name: 'show/episode-1.mkv', size: 100 },
                { index: 1, name: 'show/episode-2.mkv', size: 100 },
              ],
            ),
          );
        }
        const requestedHash = url.searchParams.get('hashes');
        return Promise.resolve(Response.json(
          requestedHash ? summaries.filter((summary) => summary.hash === requestedHash) : summaries,
        ));
      }) as typeof fetch,
    ),
  );

  const discovered = await adapter.discoverJobs([
    { path: '/downloads/movie.mkv', caseSensitive: true },
    { path: '/downloads/show/episode-1.mkv', caseSensitive: true },
  ]);

  assertEquals(discovered.jobs.map((job) => job.id), [equalHash, descendantHash]);
  assertEquals(manifestReads.sort(), [equalHash, descendantHash]);
});

Deno.test('qBittorrent discovery rejects ownership summary changes around manifest reads', async () => {
  let summaryReads = 0;
  const adapter = new QbittorrentDownloadClient(
    new QbittorrentClient(
      'http://qbit:8080',
      '',
      '',
      ((input) => {
        const url = String(input);
        if (url.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
        if (url.includes('/torrents/files')) {
          return Promise.resolve(
            Response.json([{ index: 0, name: 'release/movie.mkv', size: 100 }]),
          );
        }
        const summary = url.includes('limit=');
        if (summary) summaryReads++;
        return Promise.resolve(Response.json([{
          hash,
          name: 'Release',
          content_path: summaryReads > 1
            ? '/downloads/changed/movie.mkv'
            : '/downloads/release/movie.mkv',
          save_path: '/downloads',
          size: 100,
          total_size: 100,
        }]));
      }) as typeof fetch,
    ),
  );
  await assertRejects(
    () => adapter.discoverJobs([{ path: '/downloads/release/movie.mkv', caseSensitive: true }]),
    Error,
    'ownership summaries changed',
  );
});

Deno.test('qBittorrent discovery fetches manifests with bounded concurrency', async () => {
  const hashes = Array.from({ length: 8 }, (_, index) => index.toString(16).padStart(40, '0'));
  let activeManifestReads = 0;
  let maximumManifestReads = 0;
  const adapter = new QbittorrentDownloadClient(
    new QbittorrentClient(
      'http://qbit:8080',
      '',
      '',
      (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/app/version')) return new Response('v5.1.2');
        if (url.pathname.endsWith('/torrents/files')) {
          const torrentHash = url.searchParams.get('hash')!;
          const index = hashes.indexOf(torrentHash);
          activeManifestReads++;
          maximumManifestReads = Math.max(maximumManifestReads, activeManifestReads);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeManifestReads--;
          return Response.json([{ index: 0, name: `release-${index}/movie.mkv`, size: 100 }]);
        }
        const requestedHashes = url.searchParams.get('hashes');
        const requested = requestedHashes === null ? hashes : [requestedHashes];
        return Response.json(requested.map((torrentHash) => {
          const index = hashes.indexOf(torrentHash);
          return {
            hash: torrentHash,
            name: `Release ${index}`,
            content_path: `/downloads/release-${index}/movie.mkv`,
            save_path: '/downloads',
            size: 100,
            total_size: 100,
          };
        }));
      }) as typeof fetch,
    ),
  );

  const discovered = await adapter.discoverJobs(hashes.map((_, index) => ({
    path: `/downloads/release-${index}/movie.mkv`,
    caseSensitive: true,
  })));

  assertEquals(discovered.jobs.map((job) => job.id), hashes);
  assertEquals(maximumManifestReads > 1, true);
  assertEquals(maximumManifestReads <= 6, true);
});

Deno.test('qBittorrent discovery ignores unrelated inventory churn', async () => {
  const unrelatedHash = 'b'.repeat(40);
  let summaryReads = 0;
  let manifestReads = 0;
  const adapter = new QbittorrentDownloadClient(
    new QbittorrentClient(
      'http://qbit:8080',
      '',
      '',
      ((input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
        if (url.pathname.endsWith('/torrents/files')) {
          manifestReads++;
          return Promise.resolve(
            Response.json([{ index: 0, name: 'release/movie.mkv', size: 100 }]),
          );
        }
        const requestedHash = url.searchParams.get('hashes');
        if (requestedHash) {
          return Promise.resolve(Response.json([{
            hash,
            name: 'Release',
            content_path: '/downloads/release/movie.mkv',
            save_path: '/downloads',
            size: 100,
            total_size: 100,
          }]));
        }
        summaryReads++;
        return Promise.resolve(Response.json([
          {
            hash,
            name: 'Release',
            content_path: '/downloads/release/movie.mkv',
            save_path: '/downloads',
            size: 100,
            total_size: 100,
          },
          ...(summaryReads > 1
            ? [{
              hash: unrelatedHash,
              name: 'Unrelated',
              content_path: '/downloads/other/file.mkv',
              save_path: '/downloads',
              size: 200,
              total_size: 200,
            }]
            : []),
        ]));
      }) as typeof fetch,
    ),
  );

  const discovered = await adapter.discoverJobs([{
    path: '/downloads/release/movie.mkv',
    caseSensitive: true,
  }]);

  assertEquals(discovered.jobs.map((job) => job.id), [hash]);
  assertEquals(manifestReads, 1);
});

Deno.test('qBittorrent discovery rejects a new competing candidate job', async () => {
  const competingHash = 'b'.repeat(40);
  let summaryReads = 0;
  const adapter = new QbittorrentDownloadClient(
    new QbittorrentClient(
      'http://qbit:8080',
      '',
      '',
      ((input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/app/version')) return Promise.resolve(new Response('v5.1.2'));
        if (url.pathname.endsWith('/torrents/files')) {
          return Promise.resolve(
            Response.json([{ index: 0, name: 'release/movie.mkv', size: 100 }]),
          );
        }
        const requestedHash = url.searchParams.get('hashes');
        if (requestedHash) {
          return Promise.resolve(Response.json([{
            hash: requestedHash,
            name: 'Release',
            content_path: '/downloads/release/movie.mkv',
            save_path: '/downloads',
            size: 100,
            total_size: 100,
          }]));
        }
        summaryReads++;
        return Promise.resolve(Response.json([
          {
            hash,
            name: 'Release',
            content_path: '/downloads/release/movie.mkv',
            save_path: '/downloads',
            size: 100,
            total_size: 100,
          },
          ...(summaryReads > 1
            ? [{
              hash: competingHash,
              name: 'Competing release',
              content_path: '/downloads/release/movie.mkv',
              save_path: '/downloads',
              size: 100,
              total_size: 100,
            }]
            : []),
        ]));
      }) as typeof fetch,
    ),
  );

  await assertRejects(
    () =>
      adapter.discoverJobs([{
        path: '/downloads/release/movie.mkv',
        caseSensitive: true,
      }]),
    Error,
    'ownership summaries changed',
  );
});
