import { assertEquals } from '@std/assert';
import { historicalDownloadFolders } from './historicalDownloadFolders.ts';

const root = '1 0 0:1 / / rw - overlay overlay rw';
const downloads = '2 1 8:1 /Media/complete /downloads rw - ext4 /dev/sda rw';
const cleanup = '3 1 8:1 /Media/other /cleanup-downloads rw - ext4 /dev/sda rw';
const directory = () => Promise.resolve({ isDirectory: true });

Deno.test('first-time folder suggestions recognize both mount conventions without choosing between them', async () => {
  assertEquals(
    await historicalDownloadFolders(() => Promise.resolve(root + '\n' + downloads), directory),
    ['/downloads'],
  );
  assertEquals(
    await historicalDownloadFolders(() => Promise.resolve(root + '\n' + cleanup), directory),
    ['/cleanup-downloads'],
  );
  assertEquals(
    await historicalDownloadFolders(
      () => Promise.resolve([root, downloads, cleanup].join('\n')),
      directory,
    ),
    ['/downloads', '/cleanup-downloads'],
  );
});

Deno.test('folder suggestions exclude parent mounts, arbitrary mounts, files and ambiguous mounts', async () => {
  const inspected: string[] = [];
  assertEquals(
    await historicalDownloadFolders(
      () => Promise.resolve(root + '\n2 1 8:1 / /data rw - ext4 /dev/sda rw'),
      (path) => {
        inspected.push(path);
        return directory();
      },
    ),
    [],
  );
  assertEquals(inspected, []);
  assertEquals(
    await historicalDownloadFolders(
      () => Promise.resolve(downloads),
      () => Promise.resolve({ isDirectory: false }),
    ),
    [],
  );
  assertEquals(
    await historicalDownloadFolders(() => Promise.resolve(downloads + '\n' + downloads), directory),
    [],
  );
});

Deno.test('unavailable mount information or inaccessible folders do not break access setup', async () => {
  assertEquals(
    await historicalDownloadFolders(() => Promise.reject(new Error('unsupported')), directory),
    [],
  );
  assertEquals(
    await historicalDownloadFolders(
      () => Promise.resolve(downloads),
      () => Promise.reject(new Error('denied')),
    ),
    [],
  );
});
