import { assertEquals, assertExists, assertRejects, assertStringIncludes } from '@std/assert';
import type { ArrTorrentAssociation } from '../../integrations/arr/client.ts';
import {
  completedOrphanFileAttempt,
  deleteVerifiedOrphanFile,
  findRetainedSiblingPaths,
  mapArrPath,
  verifyOrphanHardlink,
  verifyTrackedHardlinks,
} from './hardlinks.ts';

Deno.test({
  name: 'orphan cleanup attempts resume only when the mounted-root path is absent',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const path = `${root}/movie.mkv`;
      await Deno.writeTextFile(path, 'media');
      const info = await Deno.lstat(root);
      const attempt = {
        root,
        path,
        rootDevice: String(info.dev),
        rootInode: String(info.ino),
      };
      assertEquals(await completedOrphanFileAttempt(attempt, new Set([root])), false);
      await Deno.remove(path);
      assertEquals(await completedOrphanFileAttempt(attempt, new Set([root])), true);
      await assertRejects(
        () => completedOrphanFileAttempt(attempt, new Set()),
        Error,
        'no longer configured',
      );
      await assertRejects(() =>
        completedOrphanFileAttempt(
          { ...attempt, root: `${root}/missing-mount` },
          new Set([`${root}/missing-mount`]),
        )
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

const association: ArrTorrentAssociation = {
  hash: 'a'.repeat(40),
  sourcePath: '/arr/downloads/release/movie.mkv',
  payloadPath: null,
  importedPath: '/arr/media/Movie/movie.mkv',
  historyId: 1,
  date: '2026-01-01T00:00:00Z',
};

Deno.test({
  name: 'orphan cleanup verifies and removes only the source hardlink',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const downloads = `${root}/downloads`;
      const library = `${root}/library`;
      await Deno.mkdir(`${downloads}/release`, { recursive: true });
      await Deno.mkdir(`${library}/Movie`, { recursive: true });
      const source = `${downloads}/release/movie.mkv`;
      const imported = `${library}/Movie/movie.mkv`;
      await Deno.writeTextFile(source, 'media');
      await Deno.link(source, imported);

      const stale = await verifyOrphanHardlink('Radarr', association, [
        { kind: 'download', arrPath: '/arr/downloads', localPath: downloads },
        { kind: 'library', arrPath: '/arr/media', localPath: library },
      ], []);
      assertEquals(stale?.file, null);
      assertStringIncludes(stale?.source.reason ?? '', 'no current managed files');

      const result = await verifyOrphanHardlink('Radarr', association, [
        { kind: 'download', arrPath: '/arr/downloads', localPath: downloads },
        { kind: 'library', arrPath: '/arr/media', localPath: library },
      ], [association.importedPath!]);
      assertExists(result?.file);
      assertEquals(result.source.verification, 'hardlink');
      assertEquals(await findRetainedSiblingPaths([result.file]), []);

      await deleteVerifiedOrphanFile(result.file);
      await assertRejects(() => Deno.lstat(source), Deno.errors.NotFound);
      assertEquals(await Deno.readTextFile(imported), 'media');
      await assertRejects(() => Deno.lstat(`${downloads}/release`), Deno.errors.NotFound);
      assertExists(await Deno.lstat(downloads));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'orphan cleanup accepts a current Radarr hardlink after the imported file was renamed',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const downloads = `${root}/downloads`;
      const library = `${root}/library`;
      await Deno.mkdir(`${downloads}/release`, { recursive: true });
      await Deno.mkdir(`${library}/Movie`, { recursive: true });
      const source = `${downloads}/release/movie.mkv`;
      const currentImported = `${library}/Movie/Movie (2024).mkv`;
      await Deno.writeTextFile(source, 'media');
      await Deno.link(source, currentImported);

      const result = await verifyOrphanHardlink('Radarr', association, [
        { kind: 'download', arrPath: '/arr/downloads', localPath: downloads },
        { kind: 'library', arrPath: '/arr/media', localPath: library },
      ], ['/arr/media/Movie/Movie (2024).mkv']);

      assertExists(result?.file);
      assertEquals(result.source.verification, 'hardlink');
      assertEquals(result.source.importedPath, '/arr/media/Movie/Movie (2024).mkv');
      assertEquals(result.file.importedPath, currentImported);
      assertEquals(await findRetainedSiblingPaths([result.file]), []);

      await deleteVerifiedOrphanFile(result.file);
      await assertRejects(() => Deno.lstat(source), Deno.errors.NotFound);
      assertEquals(await Deno.readTextFile(currentImported), 'media');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test('Windows Arr paths map case-insensitively into POSIX container paths', () => {
  assertEquals(
    mapArrPath('d:\\DOWNLOADS\\Release\\movie.mkv', 'download', [{
      kind: 'download',
      arrPath: 'D:\\Downloads',
      localPath: '/downloads',
    }]),
    {
      path: '/downloads/Release/movie.mkv',
      root: '/downloads',
      arrRoot: {
        path: 'D:\\Downloads',
        comparison: 'd:\\downloads',
        separator: '\\',
      },
    },
  );
});

Deno.test({
  name: 'orphan cleanup verifies tracked Radarr sidecars by inode within the payload',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const downloads = `${root}/downloads`;
      const library = `${root}/library`;
      await Deno.mkdir(`${downloads}/release`, { recursive: true });
      await Deno.mkdir(`${downloads}/release/other`, { recursive: true });
      await Deno.mkdir(`${library}/Movie`, { recursive: true });
      for (const name of ['movie.mkv', 'movie.idx', 'movie.sub']) {
        await Deno.writeTextFile(`${downloads}/release/${name}`, name);
        await Deno.link(`${downloads}/release/${name}`, `${library}/Movie/${name}`);
      }
      await Deno.link(
        `${library}/Movie/movie.idx`,
        `${downloads}/release/other/movie.idx`,
      );
      const mappings = [
        { kind: 'download' as const, arrPath: '/arr/downloads', localPath: downloads },
        { kind: 'library' as const, arrPath: '/arr/media', localPath: library },
      ];
      const files = await verifyTrackedHardlinks(
        '/arr/media/Movie',
        ['movie.mkv', 'movie.idx', 'movie.sub'],
        { ...association, payloadPath: '/arr/downloads/release' },
        mappings,
      );
      assertEquals(files.map((file) => file.path).sort(), [
        `${downloads}/release/movie.idx`,
        `${downloads}/release/movie.mkv`,
        `${downloads}/release/movie.sub`,
      ]);
      assertEquals(await findRetainedSiblingPaths(files), [{
        path: `${downloads}/release/other/movie.idx`,
        reason: 'No current Arr-managed hardlink verifies this entry',
      }]);
      for (const file of files) await deleteVerifiedOrphanFile(file);
      assertExists(await Deno.lstat(`${downloads}/release/other/movie.idx`));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'retained discovery walks a proven nested payload boundary',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const downloads = `${root}/downloads`;
      const library = `${root}/library`;
      await Deno.mkdir(`${downloads}/release/BDMV/STREAM`, { recursive: true });
      await Deno.mkdir(`${library}/Movie`, { recursive: true });
      const source = `${downloads}/release/BDMV/STREAM/movie.m2ts`;
      await Deno.writeTextFile(source, 'media');
      await Deno.writeTextFile(`${downloads}/release/release.nfo`, 'metadata');
      await Deno.writeTextFile(`${downloads}/release/BDMV/index.bdmv`, 'index');
      await Deno.link(source, `${library}/Movie/movie.m2ts`);
      const result = await verifyOrphanHardlink('Radarr', {
        ...association,
        sourcePath: '/arr/downloads/release/BDMV/STREAM/movie.m2ts',
        payloadPath: '/arr/downloads/release',
        importedPath: '/arr/media/Movie/movie.m2ts',
      }, [
        { kind: 'download', arrPath: '/arr/downloads', localPath: downloads },
        { kind: 'library', arrPath: '/arr/media', localPath: library },
      ], ['/arr/media/Movie/movie.m2ts']);
      assertExists(result?.file);
      assertEquals(
        (await findRetainedSiblingPaths([result.file])).map((entry) => entry.path).sort(),
        [
          `${downloads}/release/BDMV/index.bdmv`,
          `${downloads}/release/release.nfo`,
        ],
      );
      const entryLimited = await findRetainedSiblingPaths(
        [result.file],
        { maxEntries: 1, maxDepth: 12 },
      );
      assertStringIncludes(
        entryLimited.find((entry) => entry.path === `${downloads}/release`)?.reason ?? '',
        'stopped after 1 entries',
      );
      const depthLimited = await findRetainedSiblingPaths(
        [result.file],
        { maxEntries: 100, maxDepth: 0 },
      );
      assertStringIncludes(
        depthLimited.find((entry) => entry.path === `${downloads}/release/BDMV`)?.reason ?? '',
        'maximum depth of 0',
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'retained discovery shares one entry budget across payload boundaries',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const first = `${root}/first`;
      const second = `${root}/second`;
      await Deno.mkdir(first);
      await Deno.mkdir(second);
      await Deno.writeTextFile(`${first}/one.nfo`, 'one');
      await Deno.writeTextFile(`${second}/two.nfo`, 'two');
      const budget = { remainingEntries: 1 };
      const template = {
        hash: association.hash,
        importedPath: `${root}/library/movie.mkv`,
        importedRoot: `${root}/library`,
        root,
        remotePath: '/arr/downloads/movie.mkv',
        size: 1,
        method: 'hardlink' as const,
        dev: 1,
        ino: 1,
      };
      const retained = await findRetainedSiblingPaths(
        [
          { ...template, path: `${first}/movie.mkv`, boundary: first },
          { ...template, path: `${second}/movie.mkv`, boundary: second },
        ],
        { maxEntries: 1, maxDepth: 12 },
        budget,
      );

      assertEquals(budget.remainingEntries, 0);
      assertEquals(retained.filter((entry) => entry.reason.includes('No current')).length, 1);
      assertEquals(retained.some((entry) => entry.reason.includes('shared preview budget')), true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'orphan cleanup reports payload and retained-path inspection failures',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const downloads = `${root}/downloads`;
      const library = `${root}/library`;
      await Deno.mkdir(downloads);
      await Deno.mkdir(`${library}/Movie`, { recursive: true });
      const mappings = [
        { kind: 'download' as const, arrPath: '/arr/downloads', localPath: downloads },
        { kind: 'library' as const, arrPath: '/arr/media', localPath: library },
      ];
      assertEquals(
        await verifyTrackedHardlinks(
          '/arr/media/Movie',
          ['movie.mkv'],
          {
            ...association,
            sourcePath: '/arr/downloads/missing/movie.mkv',
            payloadPath: '/arr/downloads/missing',
          },
          mappings,
        ),
        [],
      );

      const retained = await findRetainedSiblingPaths([{
        hash: association.hash,
        path: `${downloads}/missing/movie.mkv`,
        importedPath: `${library}/Movie/movie.mkv`,
        importedRoot: library,
        root: downloads,
        boundary: `${downloads}/missing`,
        remotePath: '/arr/downloads/missing/movie.mkv',
        size: 1,
        method: 'hardlink',
        dev: 1,
        ino: 1,
      }]);
      assertEquals(retained.length, 1);
      assertStringIncludes(retained[0]!.reason, 'path no longer exists');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'orphan cleanup reports unverified files beside a verified hardlink',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const downloads = `${root}/downloads`;
      const library = `${root}/library`;
      await Deno.mkdir(`${downloads}/release`, { recursive: true });
      await Deno.mkdir(`${library}/Movie`, { recursive: true });
      const source = `${downloads}/release/movie.mkv`;
      await Deno.writeTextFile(source, 'media');
      await Deno.writeTextFile(`${downloads}/release/movie.nfo`, 'metadata');
      await Deno.link(source, `${library}/Movie/movie.mkv`);
      const result = await verifyOrphanHardlink('Radarr', association, [
        { kind: 'download', arrPath: '/arr/downloads', localPath: downloads },
        { kind: 'library', arrPath: '/arr/media', localPath: library },
      ], [association.importedPath!]);
      assertExists(result?.file);
      assertEquals(await findRetainedSiblingPaths([result.file]), [{
        path: `${downloads}/release/movie.nfo`,
        reason: 'No current Arr-managed hardlink verifies this entry',
      }]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'orphan cleanup retains a same-sized copy with a different inode',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const downloads = `${root}/downloads`;
      const library = `${root}/library`;
      await Deno.mkdir(`${downloads}/release`, { recursive: true });
      await Deno.mkdir(`${library}/Movie`, { recursive: true });
      await Deno.writeTextFile(`${downloads}/release/movie.mkv`, 'media');
      await Deno.writeTextFile(`${library}/Movie/movie.mkv`, 'media');

      const result = await verifyOrphanHardlink('Radarr', association, [
        { kind: 'download', arrPath: '/arr/downloads', localPath: downloads },
        { kind: 'library', arrPath: '/arr/media', localPath: library },
      ], [association.importedPath!]);
      assertEquals(result?.file, null);
      assertEquals(
        result?.source.reason,
        'Source is not the same hardlinked file as any current Arr-managed file',
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'orphan cleanup refuses identity changes between preview and deletion',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const downloads = `${root}/downloads`;
      const library = `${root}/library`;
      await Deno.mkdir(`${downloads}/release`, { recursive: true });
      await Deno.mkdir(`${library}/Movie`, { recursive: true });
      const source = `${downloads}/release/movie.mkv`;
      const imported = `${library}/Movie/movie.mkv`;
      await Deno.writeTextFile(source, 'media');
      await Deno.link(source, imported);
      const result = await verifyOrphanHardlink('Radarr', association, [
        { kind: 'download', arrPath: '/arr/downloads', localPath: downloads },
        { kind: 'library', arrPath: '/arr/media', localPath: library },
      ], [association.importedPath!]);
      assertExists(result?.file);

      await Deno.remove(source);
      await Deno.writeTextFile(source, 'media');
      await assertRejects(
        () => deleteVerifiedOrphanFile(result.file!),
        Error,
        'Hardlink verification changed',
      );
      assertEquals(await Deno.readTextFile(source), 'media');
      assertEquals(await Deno.readTextFile(imported), 'media');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'delete-time verification rejects two paths that alias one directory entry',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const directory = `${root}/shared`;
      await Deno.mkdir(directory);
      const path = `${directory}/movie.mkv`;
      const secondLink = `${root}/second-link.mkv`;
      await Deno.writeTextFile(path, 'media');
      await Deno.link(path, secondLink);
      const info = await Deno.lstat(path);

      await assertRejects(
        () =>
          deleteVerifiedOrphanFile({
            hash: association.hash,
            path,
            importedPath: `${directory}//movie.mkv`,
            importedRoot: directory,
            root: directory,
            boundary: directory,
            remotePath: '/arr/downloads/movie.mkv',
            size: info.size,
            method: 'hardlink',
            dev: info.dev!,
            ino: info.ino!,
          }),
        Error,
        'Refusing to unlink the Arr-managed evidence file',
      );
      assertEquals(await Deno.readTextFile(path), 'media');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'delete-time verification fails closed for differently-cased entries in one directory',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const directory = `${root}/shared`;
      await Deno.mkdir(directory);
      const source = `${directory}/movie.mkv`;
      const imported = `${directory}/Movie.mkv`;
      await Deno.writeTextFile(source, 'media');
      await Deno.link(source, imported);
      const info = await Deno.lstat(source);

      await assertRejects(
        () =>
          deleteVerifiedOrphanFile({
            hash: association.hash,
            path: source,
            importedPath: imported,
            importedRoot: directory,
            root: directory,
            boundary: directory,
            remotePath: '/arr/downloads/movie.mkv',
            size: info.size,
            method: 'hardlink',
            dev: info.dev!,
            ino: info.ino!,
          }),
        Error,
        'Refusing to unlink the Arr-managed evidence file',
      );
      assertEquals(await Deno.readTextFile(source), 'media');
      assertEquals(await Deno.readTextFile(imported), 'media');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'tracked cleanup never selects the Arr-managed evidence path',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/release`);
      const evidence = `${root}/release/movie.idx`;
      await Deno.writeTextFile(evidence, 'subtitle');
      await Deno.link(evidence, `${root}/second-link.idx`);
      const files = await verifyTrackedHardlinks(
        '/arr/media/release',
        ['movie.idx'],
        {
          ...association,
          sourcePath: '/arr/downloads/release/movie.idx',
          payloadPath: '/arr/downloads/release',
          importedPath: '/arr/media/release/movie.idx',
        },
        [
          { kind: 'library', arrPath: '/arr/media', localPath: root },
          { kind: 'download', arrPath: '/arr/downloads', localPath: root },
        ],
      );
      assertEquals(files, []);
      assertEquals(await Deno.readTextFile(evidence), 'subtitle');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test('delete-time verification refuses a crafted evidence-path target', async () => {
  await assertRejects(
    () =>
      deleteVerifiedOrphanFile({
        hash: association.hash,
        path: '/media/Movie/movie.mkv',
        importedPath: '/media/Movie/movie.mkv',
        importedRoot: '/media',
        root: '/media',
        boundary: '/media/Movie',
        remotePath: '/arr/downloads/Movie/movie.mkv',
        size: 1,
        method: 'hardlink',
        dev: 1,
        ino: 1,
      }),
    Error,
    'Refusing to unlink the Arr-managed evidence file',
  );
});

Deno.test({
  name: 'orphan cleanup rejects a symbolic-link path component',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const downloads = `${root}/downloads`;
      const actual = `${root}/actual-release`;
      const library = `${root}/library`;
      await Deno.mkdir(downloads);
      await Deno.mkdir(actual);
      await Deno.mkdir(`${library}/Movie`, { recursive: true });
      await Deno.writeTextFile(`${actual}/movie.mkv`, 'media');
      await Deno.link(`${actual}/movie.mkv`, `${library}/Movie/movie.mkv`);
      await Deno.symlink(actual, `${downloads}/release`);

      const result = await verifyOrphanHardlink('Radarr', association, [
        { kind: 'download', arrPath: '/arr/downloads', localPath: downloads },
        { kind: 'library', arrPath: '/arr/media', localPath: library },
      ], [association.importedPath!]);
      assertEquals(result?.file, null);
      assertEquals(result?.source.reason, 'A symbolic link appears in the path');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
