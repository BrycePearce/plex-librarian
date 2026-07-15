import { assertEquals, assertStringIncludes } from '@std/assert';
import { ArrClient } from '../../integrations/arr/client.ts';
import { QbittorrentClient } from '../../integrations/qbittorrent/client.ts';
import { resolveTorrentCleanup } from './cleanup.ts';

const hash = 'a'.repeat(40);

function arrTarget() {
  const client = new ArrClient(
    'radarr',
    'http://radarr',
    'key',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/movie?tmdbId=')) {
        return Promise.resolve(Response.json([{ id: 7, title: 'Movie' }]));
      }
      return Promise.resolve(Response.json([{
        eventType: 'downloadFolderImported',
        downloadId: hash,
        data: { droppedPath: '/downloads/release/movie.mkv' },
      }]));
    }) as typeof fetch,
  );
  return {
    instanceId: 1,
    instanceName: 'Radarr',
    client,
    addImportExclusion: true,
  };
}

function qbitTarget(
  loginResponse = new Response('Ok.', {
    headers: { 'Set-Cookie': 'SID=abc; path=/' },
  }),
) {
  const client = new QbittorrentClient(
    'http://qbit:8080',
    'user',
    'pass',
    ((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/app/version')) {
        return Promise.resolve(new Response('Forbidden', { status: 403 }));
      }
      if (url.endsWith('/auth/login')) return Promise.resolve(loginResponse.clone());
      if (url.includes('/torrents/info')) {
        return Promise.resolve(Response.json([{
          hash,
          name: 'Release',
          size: 100,
          content_path: '/downloads/release',
          tracker: 'https://tracker.example/private-passkey',
        }]));
      }
      return Promise.resolve(Response.json([{ name: 'movie.mkv' }]));
    }) as typeof fetch,
  );
  return {
    instanceKey: 'db:1',
    instanceId: 1,
    instanceName: 'qBittorrent',
    client,
  };
}

Deno.test('torrent cleanup resolves Arr import history to live redacted qBittorrent details', async () => {
  const result = await resolveTorrentCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget()],
  );
  assertEquals(result.status, 'resolved');
  assertEquals(result.torrents[0]?.hash, hash);
  assertEquals(result.torrents[0]?.sourcePath, '/downloads/release/movie.mkv');
  assertEquals(result.torrents[0]?.trackerHost, 'tracker.example');
});

Deno.test('torrent cleanup errors instead of silently skipping an unreachable client', async () => {
  const result = await resolveTorrentCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [qbitTarget(new Response('Fails.'))],
  );
  assertEquals(result.status, 'error');
  assertStringIncludes(result.reason ?? '', 'qBittorrent login failed');
});

Deno.test('torrent cleanup resumes when a previously attempted torrent is now absent', async () => {
  const target = qbitTarget();
  const absentClient = new QbittorrentClient(
    'http://qbit:8080',
    '',
    '',
    ((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith('/app/version') ? new Response('v5.1.2') : Response.json([]),
      )) as typeof fetch,
  );
  target.client = absentClient;
  const result = await resolveTorrentCleanup(
    'plex-1',
    { title: 'Movie', type: 'movie', tmdbId: 10, tvdbId: null },
    [arrTarget()],
    [target],
    new Set([`db:1:${hash}`]),
  );
  assertEquals(result.status, 'resolved');
  assertEquals(result.torrents, []);
  assertStringIncludes(result.reason ?? '', 'previously started');
});
