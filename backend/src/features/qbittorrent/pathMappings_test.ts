import { assertEquals, assertRejects } from '@std/assert';
import { qbitMappingsOverlap, validateQbittorrentPathMapping } from './pathMappings.ts';

Deno.test('qBittorrent path mapping validates one exact regular file', async () => {
  const directory = await Deno.makeTempDir();
  const file = `${directory.replaceAll('\\', '/')}/release/file.mkv`;
  await Deno.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await Deno.writeFile(file, new Uint8Array(17));
  const result = await validateQbittorrentPathMapping({
    qbittorrentPath: '/downloads',
    localPath: directory,
    caseSensitive: true,
    validationQbittorrentPath: '/downloads/release/file.mkv',
    validationLocalPath: file,
    validationSize: 17,
  });
  assertEquals(result.qbittorrentPath, '/downloads');
  assertEquals(result.validationSize, 17);
});

Deno.test('qBittorrent path mapping rejects mismatched relative paths and sizes', async () => {
  const directory = await Deno.makeTempDir();
  const file = `${directory.replaceAll('\\', '/')}/file.mkv`;
  await Deno.writeFile(file, new Uint8Array(17));
  await assertRejects(() =>
    validateQbittorrentPathMapping({
      qbittorrentPath: '/downloads',
      localPath: directory,
      caseSensitive: true,
      validationQbittorrentPath: '/downloads/different.mkv',
      validationLocalPath: file,
      validationSize: 18,
    })
  );
});

Deno.test('qBittorrent path mapping preserves relative casing on case-sensitive hosts', async () => {
  if (Deno.build.os === 'windows') return;
  const directory = await Deno.makeTempDir();
  const file = `${directory}/release/file.mkv`;
  await Deno.mkdir(`${directory}/release`, { recursive: true });
  await Deno.writeFile(file, new Uint8Array(17));
  await assertRejects(
    () =>
      validateQbittorrentPathMapping({
        qbittorrentPath: '/downloads',
        localPath: directory,
        caseSensitive: false,
        validationQbittorrentPath: '/downloads/Release/File.mkv',
        validationLocalPath: file,
        validationSize: 17,
      }),
    Error,
    'same relative file',
  );
});

Deno.test('qBittorrent path mapping rejects overlapping remote or local roots', () => {
  assertEquals(
    qbitMappingsOverlap([
      { qbittorrentPath: '/downloads', localPath: '/data', caseSensitive: true },
      { qbittorrentPath: '/downloads/tv', localPath: '/other', caseSensitive: true },
    ]),
    true,
  );
  assertEquals(
    qbitMappingsOverlap([
      { qbittorrentPath: '/downloads-a', localPath: '/data', caseSensitive: true },
      { qbittorrentPath: '/downloads-b', localPath: '/data/tv', caseSensitive: true },
    ]),
    true,
  );
});
