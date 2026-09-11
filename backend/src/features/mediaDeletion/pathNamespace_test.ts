import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  lstatChain,
  physicalFilesystemIdentity,
  type PlexNamespaceMappingRecord,
  provePhysicalDeletionIndependence,
  resolvePathNamespace,
} from './pathNamespace.ts';

Deno.test('physical evidence rejects rounded file and parent IDs before persisting them', () => {
  const original = Number(10133099163766247n);
  const replacement = Number(10133099163766249n);
  assertEquals(original, replacement);
  for (const ino of [original, replacement, null, NaN, Infinity, 1.5]) {
    assertThrows(
      () => physicalFilesystemIdentity({ dev: 1, ino }, 'Selected file'),
      Error,
      'no stable filesystem identity',
    );
  }
  assertThrows(() => physicalFilesystemIdentity({ dev: original, ino: 7 }, 'Selected parent'));
  assertEquals(physicalFilesystemIdentity({ dev: 1, ino: 7 }, 'Selected file'), {
    dev: '1',
    ino: '7',
  });
});

async function hasExactStatIds(paths: string[]): Promise<boolean> {
  const stats = await Promise.all(paths.map((path) => Deno.lstat(path)));
  return stats.every((info) => Number.isSafeInteger(info.dev) && Number.isSafeInteger(info.ino));
}

Deno.test('local identity rejects a symlink in any parent component', async () => {
  const root = await Deno.makeTempDir();
  try {
    const real = `${root}/real`;
    const alias = `${root}/alias`;
    await Deno.mkdir(real);
    await Deno.writeTextFile(`${real}/file.mkv`, 'video');
    try {
      await Deno.symlink(real, alias, { type: 'dir' });
      await assertRejects(
        () => lstatChain(`${alias}/file.mkv`),
        Error,
        'Symbolic links are unavailable',
      );
    } catch (error) {
      if (
        Deno.build.os !== 'windows' || !(error instanceof Error) ||
        !/privilege/i.test(error.message)
      ) throw error;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const plexMapping: PlexNamespaceMappingRecord = {
  id: 3,
  serverId: 1,
  libraryKey: 'movies',
  plexPath: '/plex/movies',
  localPath: '/media/movies',
  caseSensitive: true,
  revision: 4,
};

Deno.test('three-namespace resolution requires explicit unambiguous edges', () => {
  assertEquals(
    resolvePathNamespace('/plex/movies/Kept/file.mkv', [plexMapping], [{
      kind: 'library',
      arrPath: 'D:\\Movies',
      localPath: '/media/movies',
    }]),
    {
      plexMappingId: 3,
      plexMappingRevision: 4,
      plexPath: '/plex/movies/Kept/file.mkv',
      localPath: '/media/movies/Kept/file.mkv',
      arrPath: 'D:\\Movies\\Kept\\file.mkv',
      arrMappingKind: 'library',
      arrMappingRoot: 'D:\\Movies',
      arrLocalRoot: '/media/movies',
    },
  );
  assertEquals(resolvePathNamespace('/media/movies/Kept/file.mkv', [], []), null);
  assertEquals(
    resolvePathNamespace('/plex/movies/Kept/file.mkv', [plexMapping], [
      { kind: 'library', arrPath: '/movies', localPath: '/media/movies' },
      { kind: 'download', arrPath: '/downloads', localPath: '/media/movies' },
    ]),
    null,
  );
});

Deno.test('physical deletion-independence rejects aliases and accepts distinct files', async () => {
  const root = await Deno.makeTempDir();
  try {
    const selectedDir = `${root}/selected`;
    const retainedDir = `${root}/retained`;
    await Deno.mkdir(selectedDir);
    await Deno.mkdir(retainedDir);
    const selected = `${selectedDir}/old.mkv`;
    const retained = `${retainedDir}/kept.mkv`;
    await Deno.writeTextFile(selected, 'old');
    await Deno.writeTextFile(retained, 'kept');
    if (await hasExactStatIds([selected, retained, selectedDir, retainedDir])) {
      const evidence = await provePhysicalDeletionIndependence(selected, retained, 3, 4);
      assertEquals(evidence.selectedSize, 3);
      assertEquals(evidence.retainedSize, 4);
    } else {
      await assertRejects(
        () => provePhysicalDeletionIndependence(selected, retained, 3, 4),
        Error,
        'no stable filesystem identity',
      );
    }

    const alias = `${root}/alias.mkv`;
    try {
      await Deno.symlink(retained, alias);
      await assertRejects(
        () => provePhysicalDeletionIndependence(selected, alias, 3, 4),
        Error,
        'Symbolic links are unavailable',
      );
    } catch (error) {
      if (
        Deno.build.os !== 'windows' || !(error instanceof Error) ||
        !/privilege/i.test(error.message)
      ) {
        throw error;
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('physical deletion-independence accepts two independently named hardlinks', async () => {
  const root = await Deno.makeTempDir();
  try {
    const selectedDir = `${root}/selected`;
    const retainedDir = `${root}/retained`;
    await Deno.mkdir(selectedDir);
    await Deno.mkdir(retainedDir);
    const selected = `${selectedDir}/old.mkv`;
    const retained = `${retainedDir}/kept.mkv`;
    await Deno.writeTextFile(selected, 'video');
    await Deno.link(selected, retained);

    if (await hasExactStatIds([selected, retained, selectedDir, retainedDir])) {
      const evidence = await provePhysicalDeletionIndependence(selected, retained, 5, 5);
      assertEquals(evidence.selectedInode, evidence.retainedInode);
      assertEquals(evidence.selectedCanonicalPath === evidence.retainedCanonicalPath, false);
    } else {
      await assertRejects(
        () => provePhysicalDeletionIndependence(selected, retained, 5, 5),
        Error,
        'no stable filesystem identity',
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
