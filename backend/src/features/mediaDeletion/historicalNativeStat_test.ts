import { deepStrictEqual, notStrictEqual, rejects, strictEqual, throws } from 'node:assert';
import { lstat } from 'node:fs/promises';
import {
  exactHistoricalId,
  historicalNativeStat,
  parseHistoricalNativeStat,
} from './historicalNativeStat.ts';
import {
  type HistoricalFileSnapshot,
  historicalFileUnchanged,
  historicalRootUnchanged,
  inspectHistoricalFile,
  stableFilesystemIdentity,
} from './historicalDownloadIdentity.ts';

const output = (dev: string, ino: string) =>
  `${dev}\n${ino}\n12\n81a4\n2026-09-20 00:00:00.123456789 +0000\n2026-09-20 00:00:00.123456789 +0000\n`;

Deno.test('confirmed Unraid root, parent and source IDs retain exact native digits', () => {
  for (
    const [object, numericText, bigintText, native] of [
      ['download root', '648799825613029800', '648799825613029760', '648799825613029714'],
      ['parent directory', '649925725556682000', '649925725556681984', '649925725556681959'],
      ['source file', '649925721227816700', '649925721227816704', '649925721227816726'],
    ]
  ) {
    // Both displays describe the same rounded binary64 value, not the native ID.
    strictEqual(String(BigInt(Number(numericText))), bigintText);
    strictEqual(Number(native), Number(numericText));
    strictEqual(Number.isSafeInteger(Number(native)), false);
    notStrictEqual(native, bigintText);
    const exact = parseHistoricalNativeStat(output('44', native), object);
    strictEqual(exact.dev, '44');
    strictEqual(exact.ino, native);
    strictEqual(stableFilesystemIdentity(exact), `44:${native}`);
    deepStrictEqual(JSON.parse(JSON.stringify(exact)), exact);
    throws(() => stableFilesystemIdentity({ dev: 44, ino: Number(numericText) }));
  }
});

Deno.test('truncated, malformed and unexpected native output fail closed', () => {
  const valid = output('44', '649925721227816726');
  for (
    const malformed of [
      '',
      valid.slice(0, -1),
      valid + 'extra\n',
      valid.replace('81a4', 'not-a-mode'),
      valid.replace('12\n', '-1\n'),
      valid.replace('2026-09-20', '?'),
    ]
  ) {
    throws(() => parseHistoricalNativeStat(malformed, 'source file'));
  }
});

Deno.test('native decimal identities preserve all unsigned bits and reject unavailable evidence', () => {
  const first = '9007199254740992';
  const second = '9007199254740993';
  strictEqual(Number(first), Number(second));
  notStrictEqual(
    stableFilesystemIdentity(parseHistoricalNativeStat(output('0', first), 'root')),
    stableFilesystemIdentity(parseHistoricalNativeStat(output('0', second), 'root')),
  );
  strictEqual(
    parseHistoricalNativeStat(output('18446744073709551615', second), 'parent').dev,
    '18446744073709551615',
  );
  for (const field of ['dev', 'ino'] as const) {
    for (const bad of [null, -1, Number(first), '', '-1', '1.5', '18446744073709551616', '01']) {
      throws(() => exactHistoricalId(bad, field));
    }
  }
  throws(() => exactHistoricalId('0', 'ino'));
  for (const object of ['download root', 'parent directory', 'source file']) {
    for (const [dev, ino, field] of [['-1', '1', 'dev'], ['1', '0', 'ino']]) {
      try {
        parseHistoricalNativeStat(output(dev, ino), object);
        throw new Error('Expected invalid identity');
      } catch (error) {
        strictEqual(String(error).includes('Ordinary service deletion'), true);
        strictEqual(
          (error as { details: string }).details.includes(`${object}: Error: Invalid ${field}`),
          true,
        );
      }
    }
  }
});

Deno.test('old numeric snapshots never become new unlink or absence authority', async () => {
  const old = {
    version: 1,
    path: '/not-inspected',
    root: '/not-inspected',
    device: 1,
    inode: 2,
  } as unknown as HistoricalFileSnapshot;
  strictEqual(await historicalFileUnchanged(old, '/app-data'), false);
  strictEqual(await historicalRootUnchanged(old), false);
});

Deno.test({
  name: 'Linux native exact IDs survive durable JSON and detect changed files',
  ignore: Deno.build.os !== 'linux',
  fn: async () => {
    // Set this to a disposable-capable DrvFS directory to exercise real >2^53 IDs.
    const largeDirectory = Deno.env.get('HISTORICAL_LARGE_ID_DIR');
    const temp = await Deno.makeTempDir({
      prefix: 'plex-native-identity-',
      ...(largeDirectory ? { dir: largeDirectory } : {}),
    });
    try {
      const root = `${temp}/downloads`;
      const parent = `${root}/release`;
      const app = `${temp}/app`;
      await Deno.mkdir(parent, { recursive: true });
      await Deno.mkdir(app);
      let file = '';
      let native!: Awaited<ReturnType<typeof historicalNativeStat>>;
      for (let i = 0; i < (largeDirectory ? 64 : 1); i++) {
        file = `${parent}/episode-${i}`;
        await Deno.writeTextFile(file, 'test fixture');
        native = await historicalNativeStat(file, 'source');
        if (
          !largeDirectory ||
          (BigInt(native.ino) > 9007199254740991n && BigInt(native.ino) % 2n === 1n)
        ) break;
      }
      if (largeDirectory) {
        strictEqual(BigInt(native.ino) > 9007199254740991n, true);
        strictEqual(BigInt(native.ino) % 2n, 1n);
        const numeric = await Deno.lstat(file);
        const bigint = await lstat(file, { bigint: true });
        strictEqual(Number.isSafeInteger(numeric.ino), false);
        // Pin the actual runtime defect, not an assumption about bigint support.
        strictEqual(Deno.version.deno, '2.9.5');
        notStrictEqual(String(bigint.ino), native.ino);
        console.log(
          JSON.stringify({
            nativeInode: native.ino,
            denoInode: numeric.ino,
            bigintInode: String(bigint.ino),
          }),
        );
      }
      const snapshot = await inspectHistoricalFile(file, root, app);
      strictEqual(snapshot.inode, native.ino);
      strictEqual(
        snapshot.rootIdentity,
        stableFilesystemIdentity(await historicalNativeStat(root, 'root')),
      );
      strictEqual(
        snapshot.parentIdentity,
        stableFilesystemIdentity(await historicalNativeStat(parent, 'parent')),
      );
      const persisted = JSON.parse(JSON.stringify(snapshot));
      deepStrictEqual(persisted, snapshot);
      strictEqual(await historicalFileUnchanged(persisted, app), true);
      strictEqual(await historicalRootUnchanged(persisted), true);
      // Every identity independently vetoes revalidation when it changes.
      for (
        const change of [
          { rootIdentity: '44:648799825613029714' },
          { parentIdentity: '44:649925725556681959' },
          { device: '44', inode: '649925721227816726' },
        ]
      ) {
        strictEqual(await historicalFileUnchanged({ ...persisted, ...change }, app), false);
      }
      await rejects(() => historicalNativeStat(`${temp}/absent`, 'source file'));
      await Deno.rename(file, `${file}.old`);
      await Deno.writeTextFile(file, 'test fixture');
      strictEqual(await historicalFileUnchanged(persisted, app), false);
      const replacement = await inspectHistoricalFile(file, root, app);
      await Deno.utime(file, new Date(0), new Date(0));
      strictEqual(await historicalFileUnchanged(replacement, app), false);
      await Deno.symlink(file, `${file}.link`);
      await rejects(() => inspectHistoricalFile(`${file}.link`, root, app));
    } finally {
      // Only this test's newly created directory is removed.
      await Deno.remove(temp, { recursive: true });
    }
  },
});
