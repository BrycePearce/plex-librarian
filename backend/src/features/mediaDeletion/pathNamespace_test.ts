import { assertEquals, assertRejects } from '@std/assert';
import {
  lstatChain,
  type PlexNamespaceMappingRecord,
  provePhysicalDeletionIndependence,
  resolvePathNamespace,
} from './pathNamespace.ts';

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
    const evidence = await provePhysicalDeletionIndependence(selected, retained, 3, 4);
    assertEquals(evidence.selectedSize, 3);
    assertEquals(evidence.retainedSize, 4);

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

    const evidence = await provePhysicalDeletionIndependence(selected, retained, 5, 5);
    assertEquals(evidence.selectedInode, evidence.retainedInode);
    assertEquals(evidence.selectedCanonicalPath === evidence.retainedCanonicalPath, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
