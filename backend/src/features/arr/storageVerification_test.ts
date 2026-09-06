import { assertEquals } from '@std/assert';
import { inspectStorageRoots, verifyArrStorage } from './storageVerification.ts';

const mappings = [{ kind: 'library' as const, arrPath: '/tv', localPath: '/media' }];
function client(): Parameters<typeof verifyArrStorage>[0] {
  return {
    lookup: (id) => Promise.resolve({ id, title: 'Show', path: '/tv/Show', seasons: null }),
    mediaFiles: () =>
      Promise.resolve([
        { id: 4, path: '/tv/Show/episode.mkv', relativePath: 'episode.mkv', size: 10 },
        { id: 5, path: '/tv/Show/selected.mkv', relativePath: 'selected.mkv', size: 20 },
      ]),
  };
}

Deno.test('library-only access verifies a current file without history or download mappings', async () => {
  const api = {
    ...client(),
    torrentAssociations: () => {
      throw new Error('history must not be read');
    },
  };
  const result = await verifyArrStorage(api, [20], mappings, {
    inspect: (path) => {
      assertEquals(path, '/media/Show/episode.mkv');
      return Promise.resolve({ isFile: true, size: 10 } as Deno.FileInfo);
    },
  });
  assertEquals(result.status, 'verified');
  assertEquals(result.libraryPath, '/media/Show/episode.mkv');
  assertEquals(result.historical, undefined);
  assertEquals(result.downloadPath, undefined);
});

Deno.test('selected current file is verified instead of another episode', async () => {
  const inspected: string[] = [];
  const result = await verifyArrStorage(client(), [20], mappings, {
    inspect: (path) => {
      inspected.push(path);
      return Promise.resolve({ isFile: true, size: 20 } as Deno.FileInfo);
    },
  }, '/tv/Show/selected.mkv');
  assertEquals(inspected, ['/media/Show/selected.mkv']);
  assertEquals(result.library?.arrPath, '/tv/Show/selected.mkv');
  assertEquals(result.status, 'verified');
});

Deno.test('a stale selected path never falls back to an unrelated file', async () => {
  const result = await verifyArrStorage(client(), [20], mappings, {
    inspect: () => {
      throw new Error('no current selected file');
    },
  }, '/tv/Show/old.mkv');
  assertEquals(result.status, 'unverified');
  assertEquals(result.library?.status, 'no_sample');
});

Deno.test('mismatched sizes or directory presence do not verify media access', async () => {
  for (const info of [{ isFile: true, size: 99 }, { isFile: false, size: 20 }]) {
    const result = await verifyArrStorage(client(), [20], mappings, {
      inspect: () => Promise.resolve(info as Deno.FileInfo),
    }, '/tv/Show/selected.mkv');
    assertEquals(result.status, 'unverified');
    assertEquals(result.libraryPath, undefined);
  }
});

Deno.test('missing local mount reports the exact current file translation', async () => {
  const result = await verifyArrStorage(client(), [20], mappings, {
    inspect: () => Promise.reject(new Deno.errors.NotFound('missing mount')),
  }, '/tv/Show/selected.mkv');
  assertEquals(result.library?.status, 'unavailable');
  assertEquals(result.library?.arrPath, '/tv/Show/selected.mkv');
  assertEquals(result.library?.localPath, '/media/Show/selected.mkv');
  assertEquals(result.libraryPath, undefined);
});

Deno.test('no synced sample is distinct from an inaccessible mount', async () => {
  const result = await verifyArrStorage(client(), [], mappings);
  assertEquals(result.library?.status, 'no_sample');
  assertEquals(result.library?.localPath, undefined);
  assertEquals(result.historical, undefined);
});

Deno.test('storage root checks distinguish missing folders from inaccessible and existing mounts', async () => {
  const roots = await inspectStorageRoots([
    ...mappings,
    { kind: 'download', arrPath: '/downloads', localPath: '/downloads' },
    { kind: 'library', arrPath: '/custom', localPath: '/existing-media' },
  ], (path) => {
    if (path === '/media') return Promise.reject(new Deno.errors.NotFound());
    if (path === '/downloads') return Promise.reject(new Deno.errors.PermissionDenied());
    return Promise.resolve({ isDirectory: true } as Deno.FileInfo);
  });
  assertEquals(roots.map((root) => root.status), ['missing', 'inaccessible', 'accessible']);
});
