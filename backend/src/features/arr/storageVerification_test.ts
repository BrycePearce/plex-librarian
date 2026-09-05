import { assertEquals, assertStringIncludes } from '@std/assert';
import { verifyArrStorage } from './storageVerification.ts';

const mappings = [
  { kind: 'library' as const, arrPath: '/tv', localPath: '/media' },
  { kind: 'download' as const, arrPath: '/data/downloads', localPath: '/downloads' },
];
function client(): Parameters<typeof verifyArrStorage>[0] {
  return {
    type: 'sonarr',
    lookup: (id) => Promise.resolve({ id, title: 'Show', path: '/tv/Show', seasons: null }),
    mediaFiles: () =>
      Promise.resolve([{
        id: 4,
        path: '/tv/Show/episode.mkv',
        relativePath: 'episode.mkv',
        size: 10,
      }]),
    torrentAssociations: () =>
      Promise.resolve([{
        hash: 'a'.repeat(40),
        sourcePath: '/data/downloads/episode.mkv',
        importedPath: '/tv/Show/episode.mkv',
        payloadPath: null,
        historyId: 1,
        date: null,
      }]),
  };
}

Deno.test('storage verification checks mapped library size then delegates the hardlink proof', async () => {
  let proofs = 0;
  const result = await verifyArrStorage(client(), [20], mappings, {
    inspect: (path) => {
      assertEquals(path, '/media/Show/episode.mkv');
      return Promise.resolve({ isFile: true, size: 10 } as Deno.FileInfo);
    },
    verify: (_name, _association, paths, files, options) => {
      proofs++;
      assertEquals(paths, mappings);
      assertEquals(files, [{ path: '/tv/Show/episode.mkv', id: 4, size: 10 }]);
      assertEquals(options, { exactTwoLinks: true });
      return Promise.resolve(
        {
          file: { path: '/downloads/episode.mkv', importedPath: '/media/Show/episode.mkv' },
        } as Awaited<ReturnType<NonNullable<Parameters<typeof verifyArrStorage>[3]>['verify']>>,
      );
    },
  });
  assertEquals(proofs, 1);
  assertEquals(result.status, 'verified');
  assertEquals(result.downloadPath, '/downloads/episode.mkv');
});

Deno.test('mismatched library file sizes do not produce verified storage', async () => {
  let inspected = 0;
  const result = await verifyArrStorage(client(), [1, 2, 3, 4, 5], mappings, {
    inspect: () => {
      inspected++;
      return Promise.resolve({ isFile: true, size: 99 } as Deno.FileInfo);
    },
    verify: () => {
      throw new Error('must not verify downloads with no library sample');
    },
  });
  assertEquals(inspected, 3);
  assertEquals(result.status, 'unverified');
  assertEquals(result.libraryPath, undefined);
});

Deno.test('a missing historical sample preserves the successful library access check', async () => {
  const result = await verifyArrStorage(client(), [20], mappings, {
    inspect: () => Promise.resolve({ isFile: true, size: 10 } as Deno.FileInfo),
    verify: () => Promise.resolve(null),
  });
  assertEquals(result.status, 'unverified');
  assertEquals(result.libraryPath, '/media/Show/episode.mkv');
  assertStringIncludes(result.reason, 'You can save');
});
