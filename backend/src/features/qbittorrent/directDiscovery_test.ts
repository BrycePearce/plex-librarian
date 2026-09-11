import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import type { DownloadClientTarget } from '../mediaDeletion/downloadClient.ts';
import { createLocalPathIdentityResolver } from '../mediaDeletion/localPathIdentity.ts';
import {
  associatedCurrentJobCandidates,
  completeDirectManifestSelection,
  directDiscoveryCandidates,
  directFilesystemIdentity,
  type DirectLocalIdentity,
  directManifestRemotePaths,
  directManifestSelection,
} from './directDiscovery.ts';

Deno.test('direct discovery rejects rounded filesystem IDs before they can authorize another file', () => {
  const selectedInode = Number(10133099163766247n);
  const retainedPayloadInode = Number(10133099163766249n);
  assertEquals(selectedInode, retainedPayloadInode);
  for (const ino of [selectedInode, retainedPayloadInode]) {
    assertThrows(
      () => directFilesystemIdentity({ dev: 1, ino }),
      Error,
      'no exact filesystem identity',
    );
  }
  for (const value of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertThrows(() => directFilesystemIdentity({ dev: value, ino: 7 }));
    assertThrows(() => directFilesystemIdentity({ dev: 1, ino: value }));
  }
  assertThrows(() => directFilesystemIdentity({ dev: 1, ino: null }));
  assertEquals(directFilesystemIdentity({ dev: 1, ino: Number.MAX_SAFE_INTEGER }), {
    device: '1',
    inode: String(Number.MAX_SAFE_INTEGER),
  });
});

Deno.test('Arr association finds a separate moved current payload without authorizing old paths', async () => {
  const target = {
    client: {
      findJob: (id: string) =>
        Promise.resolve({ id, contentPath: '/current/downloads/moved-pack' }),
    },
  } as unknown as DownloadClientTarget;
  assertEquals(await associatedCurrentJobCandidates(target, new Set(['associated-hash'])), [
    { path: '/current/downloads/moved-pack', caseSensitive: true },
  ]);
  const selected = { plexPath: '/plex/episode.mkv', local: identity('/library/episode.mkv', '7') };
  const moved = identity('/current/downloads/moved-pack/episode.mkv', '7');
  assertEquals(completeDirectManifestSelection([moved], [selected], []), [selected]);
  assertEquals(completeDirectManifestSelection([identity(moved.path, '9')], [selected], []), null);
  assertThrows(
    () =>
      completeDirectManifestSelection([moved, identity('/current/other.mkv', '9')], [selected], []),
    Error,
    'unselected or unverifiable',
  );
});

Deno.test('associated current job lookup preserves no-match and offline distinction', async () => {
  const absent = {
    client: { findJob: () => Promise.resolve(null) },
  } as unknown as DownloadClientTarget;
  assertEquals(await associatedCurrentJobCandidates(absent, new Set(['hash'])), []);
  const offline = {
    client: { findJob: () => Promise.reject(new Error('QB offline')) },
  } as unknown as DownloadClientTarget;
  await assertRejects(
    () => associatedCurrentJobCandidates(offline, new Set(['hash'])),
    Error,
    'QB offline',
  );
});

Deno.test('one verified associated job cannot hide another unresolved live payload', () => {
  const selected = { plexPath: '/plex/episode.mkv', local: identity('/library/episode.mkv', '7') };
  const manifests = [
    [identity('/current/verified/episode.mkv', '7')],
    [identity('/current/moved/episode.mkv', '9')],
  ];
  assertThrows(
    () => manifests.map((files) => completeDirectManifestSelection(files, [selected], [], true)),
    Error,
    'associated current qBittorrent payload could not be verified',
  );
});

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

Deno.test('direct retained protection resolves bind aliases while permitting distinct hardlink entries', async () => {
  const identify = await createLocalPathIdentityResolver({
    mountInfo: [
      '1 0 8:1 / / rw - ext4 /dev/sda rw',
      '2 1 8:1 /storage /downloads rw - ext4 /dev/sda rw',
      '3 1 8:1 /storage /retained rw - ext4 /dev/sda rw',
    ].join('\n'),
    realPath: (path) => Promise.resolve(path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')),
  });
  const file = async (path: string) => ({
    ...identity(path, '7'),
    entry: (await identify(path)).possibleEntry,
  });
  const selected = { plexPath: '/plex/a.mkv', local: await file('/library/a.mkv') };
  const payload = await file('/downloads/a.mkv');
  const alias = { plexPath: '/other/a.mkv', local: await file('/retained/a.mkv') };
  assertThrows(() => directManifestSelection(payload, [selected], [alias]), Error, 'aliases');
  const hardlink = { plexPath: '/other/kept.mkv', local: await file('/library/kept.mkv') };
  assertEquals(directManifestSelection(payload, [selected], [hardlink]), selected);
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
