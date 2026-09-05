import { assertEquals, assertRejects } from '@std/assert';
import { createLocalPathIdentityResolver, identityContains } from './localPathIdentity.ts';
import {
  discoverMappedDownloadJobs,
  localDownloadJobOwnedPaths,
} from './mappedDownloadDiscovery.ts';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';

Deno.test({
  name: 'shipped backend commands can read Linux mount identities',
  ignore: Deno.build.os !== 'linux',
  async fn() {
    const dockerfile = await Deno.readTextFile(new URL('../../../../Dockerfile', import.meta.url));
    const command = JSON.parse(dockerfile.slice(dockerfile.lastIndexOf('CMD [') + 4)) as string[];
    const config = JSON.parse(
      await Deno.readTextFile(new URL('../../../deno.json', import.meta.url)),
    );
    const script = await Deno.makeTempFile({ suffix: '.ts' });
    try {
      await Deno.writeTextFile(
        script,
        "const mounts = await Deno.readTextFile('/proc/self/mountinfo'); if (!mounts.includes(' - ')) throw new Error('Missing mount identities');",
      );
      for (
        const invocation of [command, config.tasks.start.split(' '), config.tasks.dev.split(' ')]
      ) {
        // Exercise the shipped permissions, without starting the server or watcher.
        const flags = invocation.slice(2, -1).filter((arg: string) =>
          arg !== '--watch' && !arg.startsWith('--env-file=')
        );
        const result = await new Deno.Command(Deno.execPath(), {
          args: ['run', ...flags, script],
          stdout: 'piped',
          stderr: 'piped',
        }).output();
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      }
    } finally {
      await Deno.remove(script);
    }
  },
});

const mounts = [
  '1 0 8:1 / / rw - ext4 /dev/sda rw',
  '2 1 8:1 /storage /media rw - ext4 /dev/sda rw',
  '3 1 8:1 /storage /downloads rw - ext4 /dev/sda rw',
  '4 1 8:1 /storage/Show/episode.mkv /single.mkv rw - ext4 /dev/sda rw',
  '5 2 8:2 /extra /media/nested rw - ext4 /dev/sdb rw',
  '6 1 8:2 /extra /extra-downloads rw - ext4 /dev/sdb rw',
].join('\n');
const realPath = (path: string) =>
  Promise.resolve(path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, ''));

Deno.test('filesystem identity recognizes bind aliases and nested mount deletion scopes', async () => {
  const identify = await createLocalPathIdentityResolver({ mountInfo: mounts, realPath });
  const media = await identify('/media/Show/episode.mkv');
  assertEquals(media.entry, (await identify('/downloads/Show/episode.mkv')).entry);
  assertEquals(media.entry, (await identify('/single.mkv')).entry);
  assertEquals(
    identityContains(await identify('/media'), await identify('/downloads/Show/episode.mkv')),
    true,
  );
  assertEquals(
    identityContains(await identify('/media'), await identify('/extra-downloads/file.mkv')),
    true,
  );
  // Same device is not ownership: independent directory entries remain independent.
  assertEquals(media.entry === (await identify('/media/Library/episode.mkv')).entry, false);
});

Deno.test('mount escapes and missing paths resolve without guessing inaccessible storage', async () => {
  const identify = await createLocalPathIdentityResolver({
    mountInfo: mounts + '\n7 1 8:1 /storage /with\\040space rw - ext4 /dev/sda rw',
    realPath: (path) =>
      path.endsWith('missing.mkv') ? Promise.reject(new Deno.errors.NotFound()) : realPath(path),
  });
  assertEquals(
    (await identify('/with space/Show/missing.mkv')).entry,
    (await identify('/media/Show/missing.mkv')).entry,
  );
  const inaccessible = await createLocalPathIdentityResolver({
    mountInfo: mounts,
    realPath: () => Promise.reject(new Deno.errors.PermissionDenied()),
  });
  await assertRejects(() => inaccessible('/media/file'));
  await assertRejects(() => identify('/media/Show/missing.mkv', true));
  await assertRejects(() => createLocalPathIdentityResolver({ mountInfo: '' }));
});

Deno.test('stacked mounts and case-only equality cannot establish exact ownership', async () => {
  const ambiguous = await createLocalPathIdentityResolver({
    mountInfo: mounts +
      '\n8 1 8:3 /other /media rw - ext4 /dev/sdc rw',
    realPath,
  });
  await assertRejects(() => ambiguous('/media/file'), Error, 'stacked');
  const identify = await createLocalPathIdentityResolver({ mountInfo: mounts, realPath });
  const upper = await identify('/media/Foo.mkv');
  const lower = await identify('/downloads/foo.mkv');
  assertEquals(upper.entry === lower.entry, false);
  assertEquals(upper.possibleEntry === lower.possibleEntry, true);
});

Deno.test('mapped QB discovery protects aliases but leaves independent library entries deletable', async () => {
  const identify = await createLocalPathIdentityResolver({ mountInfo: mounts, realPath });
  const job = {
    id: 'job',
    contentPath: '/qb/Show/episode.mkv',
    savePath: '/qb',
    size: 10,
    manifestFiles: [{ path: 'Show/episode.mkv', size: 10 }],
  } as DownloadJob;
  let manifestReads = 0;
  const target: DownloadClientTarget = {
    configurationIdentity: 'fixture',
    provider: 'qbittorrent',
    instanceKey: 'qb:1',
    instanceId: 1,
    instanceName: 'QB',
    pathMappings: [{
      id: 1,
      qbittorrentPath: '/qb',
      localPath: '/downloads',
      caseSensitive: true,
      revision: 1,
    }],
    client: {
      listJobSummaries: () => Promise.resolve([job]),
      findJob: () => Promise.resolve(job),
      deleteJob: () => Promise.reject(new Error('never delete in discovery')),
      discoverJobs: () => {
        manifestReads++;
        return Promise.resolve({ jobs: [job], summaryFingerprint: 'test' });
      },
    },
  };
  assertEquals(
    (await discoverMappedDownloadJobs(target, [{ path: '/media/Show', directory: true }], identify))
      .jobs.length,
    1,
  );
  assertEquals(
    await localDownloadJobOwnedPaths(job, { path: '/media/Show/episode.mkv' }, target, identify),
    ['/qb/Show/episode.mkv'],
  );
  assertEquals(
    (await discoverMappedDownloadJobs(target, [{ path: '/media/Library/episode.mkv' }], identify))
      .jobs.length,
    0,
  );
  assertEquals(manifestReads, 1);
});
