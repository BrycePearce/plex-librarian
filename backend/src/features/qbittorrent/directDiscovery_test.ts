import { assertEquals, assertThrows } from '@std/assert';
import {
  completeDirectManifestSelection,
  directDiscoveryCandidates,
  type DirectLocalIdentity,
  directManifestRemotePaths,
  directManifestSelection,
} from './directDiscovery.ts';

Deno.test('direct discovery maps selected local paths into the qBittorrent namespace', () => {
  assertEquals(
    directDiscoveryCandidates(['/downloads/show/episode.mkv'], [{
      id: 1,
      qbittorrentPath: '/data/torrents',
      localPath: '/downloads',
      caseSensitive: true,
      revision: 1,
    }]),
    [{ path: '/data/torrents/show/episode.mkv', caseSensitive: true }],
  );
});

Deno.test('direct discovery scopes candidates to paths covered by one qBittorrent target', () => {
  assertEquals(
    directDiscoveryCandidates([
      '/downloads/movies/movie.mkv',
      '/downloads/tv/show/episode.mkv',
    ], [{
      id: 1,
      qbittorrentPath: '/data/movies',
      localPath: '/downloads/movies',
      caseSensitive: true,
      revision: 1,
    }]),
    [{ path: '/data/movies/movie.mkv', caseSensitive: true }],
  );
});

Deno.test('direct discovery still rejects ambiguous mappings within one target', () => {
  assertThrows(
    () =>
      directDiscoveryCandidates(['/downloads/show/episode.mkv'], [
        {
          id: 1,
          qbittorrentPath: '/data/all',
          localPath: '/downloads',
          caseSensitive: true,
          revision: 1,
        },
        {
          id: 2,
          qbittorrentPath: '/data/shows',
          localPath: '/downloads/show',
          caseSensitive: true,
          revision: 1,
        },
      ]),
    Error,
    'multiple qBittorrent namespace mappings',
  );
});

function identity(path: string, inode: string): DirectLocalIdentity {
  return {
    path,
    size: 100,
    canonical: path,
    device: '1',
    inode,
  };
}

Deno.test('direct discovery rejects a manifest path that aliases a retained Plex version', () => {
  const selected = { plexPath: '/plex/selected.mkv', local: identity('/local/selected.mkv', '7') };
  const retained = { plexPath: '/plex/retained.mkv', local: identity('/local/retained.mkv', '7') };
  assertThrows(
    () => directManifestSelection(retained.local, [selected], [retained]),
    Error,
    'aliases an unselected retained Plex version',
  );
});

Deno.test('direct discovery still accepts an exact selected path with no retained alias', () => {
  const selected = { plexPath: '/plex/selected.mkv', local: identity('/local/selected.mkv', '7') };
  const retained = { plexPath: '/plex/retained.mkv', local: identity('/local/retained.mkv', '8') };
  assertEquals(directManifestSelection(selected.local, [selected], [retained]), selected);
});

Deno.test('direct discovery skips a completely unrelated manifest', () => {
  const selected = { plexPath: '/plex/selected.mkv', local: identity('/local/selected.mkv', '7') };
  const retained = { plexPath: '/plex/retained.mkv', local: identity('/local/retained.mkv', '8') };
  assertEquals(
    completeDirectManifestSelection(
      [identity('/local/unrelated.mkv', '9'), null],
      [selected],
      [retained],
    ),
    null,
  );
});

Deno.test('direct discovery rejects a partially verified matching payload', () => {
  const selected = { plexPath: '/plex/selected.mkv', local: identity('/local/selected.mkv', '7') };
  const retained = { plexPath: '/plex/retained.mkv', local: identity('/local/retained.mkv', '8') };
  assertThrows(
    () => completeDirectManifestSelection([selected.local, null], [selected], [retained]),
    Error,
    'contains an unselected or unverifiable file',
  );
});

Deno.test('direct discovery compares Windows manifest and content paths case-insensitively', () => {
  assertEquals(
    directManifestRemotePaths({
      id: 'abc',
      name: 'Episode',
      state: 'pausedUP',
      size: 100,
      uploaded: 0,
      completedAt: null,
      ratio: null,
      seedingTime: 0,
      savePath: 'C:\\Downloads',
      contentPath: 'c:\\downloads\\Show\\Episode.mkv',
      trackerHost: null,
      fileCount: 1,
      files: [{ path: 'Show/Episode.mkv', size: 100 }],
      filesTruncated: false,
      manifestFiles: [{ path: 'Show/Episode.mkv', size: 100 }],
    }),
    ['C:\\Downloads\\Show\\Episode.mkv'],
  );
});
