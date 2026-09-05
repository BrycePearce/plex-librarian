/** Linux integration check. Run inside an isolated user/mount namespace:
 * unshare --user --map-root-user --mount deno run --allow-all --node-modules-dir=none backend/src/features/mediaDeletion/mountAliasRegression.ts
 */
import { assertEquals, assertRejects } from '@std/assert';
import { createLocalPathIdentityResolver } from './localPathIdentity.ts';
import { assertLocalDeletionPathsUnowned } from './livePathProtection.ts';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';

if (Deno.build.os !== 'linux') throw new Error('This regression requires Linux mount namespaces');
const root = await Deno.makeTempDir({ prefix: 'plex-mount-regression-' });
const storage = `${root}/storage`;
const alias = `${root}/alias`;
let mounted = false;
try {
  await Deno.mkdir(`${storage}/Show`, { recursive: true });
  await Deno.mkdir(`${storage}/Library`);
  await Deno.mkdir(alias);
  await Deno.writeFile(`${storage}/Show/episode.mkv`, new Uint8Array(10));
  await Deno.link(`${storage}/Show/episode.mkv`, `${storage}/Library/episode.mkv`);
  const mount = await new Deno.Command('mount', { args: ['--bind', storage, alias] }).output();
  assertEquals(mount.success, true, new TextDecoder().decode(mount.stderr));
  mounted = true;
  const identify = await createLocalPathIdentityResolver();
  assertEquals(
    (await identify(`${storage}/Show/episode.mkv`)).entry,
    (await identify(`${alias}/Show/episode.mkv`)).entry,
  );
  const job = {
    id: 'fixture',
    contentPath: '/qb/Show/episode.mkv',
    savePath: '/qb',
    size: 10,
    fileCount: 1,
    filesTruncated: false,
    manifestFiles: [{ path: 'Show/episode.mkv', size: 10 }],
  } as DownloadJob;
  const target: DownloadClientTarget = {
    provider: 'qbittorrent',
    instanceKey: 'qb:1',
    instanceId: 1,
    instanceName: 'QB',
    configurationIdentity: 'fixture',
    pathMappings: [{
      id: 1,
      qbittorrentPath: '/qb',
      localPath: alias,
      caseSensitive: true,
      revision: 1,
    }],
    client: {
      listJobSummaries: () => Promise.resolve([job]),
      discoverJobs: () => Promise.resolve({ jobs: [job], summaryFingerprint: 'fixture' }),
      findJob: () => Promise.resolve(job),
      deleteJob: () => Promise.reject(new Error('The regression never deletes through QB')),
    },
  };
  for (
    const path of [{ path: `${storage}/Show/episode.mkv` }, {
      path: `${storage}/Show`,
      directory: true,
    }]
  ) {
    await assertRejects(
      () => assertLocalDeletionPathsUnowned([path], [target]),
      Error,
      'Retained because',
    );
  }
  await assertLocalDeletionPathsUnowned([{ path: `${storage}/Library/episode.mkv` }], [target]);
  await assertLocalDeletionPathsUnowned([{ path: `${storage}/Show/episode.mkv` }], []);
  console.log('PASS: actual Linux bind aliases protected; independent hardlinks remain deletable');
} finally {
  if (mounted) {
    const unmount = await new Deno.Command('umount', { args: [alias] }).output();
    assertEquals(unmount.success, true, 'Could not unmount the isolated regression fixture');
  }
  await Deno.remove(root, { recursive: true });
}
