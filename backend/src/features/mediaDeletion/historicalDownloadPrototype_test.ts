import { deepStrictEqual as equal, rejects, strictEqual, throws } from 'node:assert';
import { parseHistoricalImports } from '../../integrations/arr/historicalImports.ts';
import {
  historicalDownloadLineage,
  historicalSelectedFilesUnchanged,
} from './historicalDownloadLineage.ts';
import {
  historicalFileUnchanged,
  historicalMountEntry,
  historicalRootUnchanged,
  inspectHistoricalFile,
  stableFilesystemIdentity,
  unlinkHistoricalFile,
} from './historicalDownloadIdentity.ts';
import type { SonarrSeriesSnapshot } from '../../integrations/arr/client.ts';

Deno.test({
  name: 'native parent directory replacement invalidates an unchanged hardlinked file',
  ignore: Deno.build.os !== 'linux',
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'historical-parent-' });
    try {
      const downloads = root + '/downloads';
      const app = root + '/app';
      await Deno.mkdir(app);
      await Deno.mkdir(downloads);
      await Deno.mkdir(downloads + '/release');
      await Deno.mkdir(downloads + '/replacement');
      const path = downloads + '/release/file';
      await Deno.writeTextFile(path, 'fixture');
      await Deno.link(path, downloads + '/replacement/file');
      const before = await inspectHistoricalFile(path, downloads, app);
      await Deno.rename(downloads + '/release', downloads + '/old');
      await Deno.rename(downloads + '/replacement', downloads + '/release');
      const after = await inspectHistoricalFile(path, downloads, app);
      strictEqual(before.inode, after.inode);
      strictEqual(before.ctime, after.ctime);
      strictEqual(before.parentIdentity === after.parentIdentity, false);
      strictEqual(await historicalFileUnchanged(before, app), false);
      await rejects(() => unlinkHistoricalFile(before, app));
      let guarded = false;
      await rejects(() =>
        unlinkHistoricalFile(after, app, () => {
          guarded = true;
          throw new Error('Expired ownership checkpoint');
        })
      );
      strictEqual(guarded, true);
      strictEqual((await Deno.stat(path)).isFile, true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

async function fixture(name: string) {
  return JSON.parse(
    await Deno.readTextFile(
      new URL(`./fixtures/historical-download-cleanup/${name}.json`, import.meta.url),
    ),
  );
}

function snapshot(
  current: {
    episodes: SonarrSeriesSnapshot['episodes'];
    episodeFiles: Omit<SonarrSeriesSnapshot['files'][number], 'episodeIds'>[];
  },
): SonarrSeriesSnapshot {
  return {
    episodes: current.episodes,
    files: current.episodeFiles.map((f) => ({
      ...f,
      episodeIds: current.episodes.filter((e) => e.episodeFileId === f.id).map((e) => e.id),
    })),
  };
}

Deno.test('historical prototype: exact lineage without a torrent, full shared owners and conflicts', async () => {
  const history = await fixture('sonarr-history');
  const current = await fixture('sonarr-current');
  const synthetic = await fixture('synthetic-cases');
  const collect = (rows: unknown, inventory = current, selected = current.selections.season) =>
    historicalDownloadLineage(
      parseHistoricalImports(rows, 701),
      snapshot(inventory),
      new Set<number>(selected),
    );
  strictEqual(collect(history).candidates.length, 2);
  // Historical size is never authority: omitted, malformed, mismatched or
  // conflicting fields have the same lineage as records containing a size.
  for (const sizeFields of [{}, { size: 'invalid' }, { size: '1' }, { size: '1', Size: '2' }]) {
    const rows = history.map((r: { data: Record<string, unknown> }) => {
      const data = { ...r.data };
      delete data.size;
      delete data.Size;
      return { ...r, data: { ...data, ...sizeFields } };
    });
    equal(collect(rows), collect(history));
  }
  strictEqual(
    collect(history.map((r: Record<string, unknown>) => ({ ...r, downloadId: undefined })))
      .candidates.length,
    2,
  );
  strictEqual(collect(history, current, current.selections.single).candidates.length, 1);
  for (const [kind, rows] of Object.entries(synthetic.malformed)) {
    if (kind === 'conflictingSizes' || kind === 'malformedSize') {
      strictEqual(collect(rows).candidates.length, 1);
      continue;
    }
    strictEqual(collect(rows).candidates.length, 0);
    strictEqual(collect(rows).skipped.length > 0, true);
  }
  const shared = synthetic.shared;
  strictEqual(
    collect(shared.history, shared.current, shared.selections.partial).candidates.length,
    0,
  );
  const accepted = collect(shared.history, shared.current, shared.selections.complete).candidates;
  strictEqual(accepted.length, 1);
  equal(accepted[0].owners, [811, 812]);
  strictEqual(accepted[0].imports.length, 2);
  const changed = structuredClone(shared.current);
  changed.episodes.push({ ...changed.episodes[0], id: 813 });
  strictEqual(collect(shared.history, changed, shared.selections.complete).candidates.length, 0);
});

Deno.test('historical execution refresh checks file ID, series, path and complete owners', async () => {
  const { shared } = await fixture('synthetic-cases');
  const current = snapshot(shared.current);
  const lineage = historicalDownloadLineage(
    parseHistoricalImports(shared.history, 701),
    current,
    new Set<number>(shared.selections.complete),
  ).candidates[0];
  let file = structuredClone(current.files[0]);
  let owners = [...file.episodeIds];
  const client = {
    sonarrEpisodeFileOwnerIds: (fileId: number, seriesId: number) => {
      strictEqual(fileId, 611);
      strictEqual(seriesId, 701);
      return Promise.resolve(owners);
    },
    sonarrEpisodeFile: (id: number) => {
      strictEqual(id, 611);
      return Promise.resolve(file);
    },
  };
  strictEqual(await historicalSelectedFilesUnchanged(client, 701, lineage), true);
  for (
    const changed of [{ path: '/replacement.mkv' }, { seriesId: 702 }, { id: 612 }]
  ) {
    file = { ...current.files[0], ...changed };
    strictEqual(await historicalSelectedFilesUnchanged(client, 701, lineage), false);
  }
  file = current.files[0];
  owners = [811, 812, 813];
  strictEqual(await historicalSelectedFilesUnchanged(client, 701, lineage), false);
});

Deno.test('historical prototype: unsafe numeric identity is never rounded into authority', () => {
  for (const ino of [null, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    let rejected = false;
    try {
      stableFilesystemIdentity({ dev: 1, ino });
    } catch {
      rejected = true;
    }
    strictEqual(rejected, true);
  }
});

Deno.test('historical prototype: bind directory and file aliases share entry keys; other hardlink names differ', () => {
  const mounts = [
    '1 0 8:1 / / rw - ext4 /dev/sda rw',
    '2 1 8:1 /downloads /cleanup rw - ext4 /dev/sda rw',
    '3 1 8:1 /downloads/release/file /file-alias rw - ext4 /dev/sda rw',
  ].join('\n');
  const original = historicalMountEntry('/downloads/release/file', mounts).entry;
  strictEqual(historicalMountEntry('/cleanup/release/file', mounts).entry, original);
  strictEqual(historicalMountEntry('/file-alias', mounts).entry, original);
  throws(
    () =>
      historicalMountEntry(
        '/cleanup/release/file',
        mounts + '\n4 1 8:1 /another-root /cleanup rw - ext4 /dev/sda rw',
      ),
    /ambiguous/,
  );
  strictEqual(
    historicalMountEntry('/downloads/release/other-name', mounts).entry === original,
    false,
  );
});

Deno.test({
  name: 'historical Linux bind aliases preserve the physical entry and reject app-data aliases',
  ignore: Deno.build.os !== 'linux' || !Deno.env.get('HISTORICAL_BIND_ROOT'),
  fn: async () => {
    // System mount tools prepare this disposable namespace. Deno runs unprivileged.
    const temp = Deno.env.get('HISTORICAL_BIND_ROOT')!;
    strictEqual(temp.startsWith('/tmp/plex-historical-gate-'), true);
    const direct = await inspectHistoricalFile(
      `${temp}/source/episode`,
      `${temp}/source`,
      `${temp}/app`,
    );
    const alias = await inspectHistoricalFile(
      `${temp}/alias/episode`,
      `${temp}/alias`,
      `${temp}/app`,
    );
    strictEqual(direct.entry, alias.entry);
    await rejects(() =>
      inspectHistoricalFile(`${temp}/alias/episode`, `${temp}/alias`, `${temp}/source`)
    );
    await Deno.writeTextFile(`${temp}/app/bind-snapshot.json`, JSON.stringify(alias));
    await Deno.stat(`${temp}/source/episode`);
  },
});

Deno.test({
  name: 'historical Linux bind gate: an unmounted alias cannot become already absent',
  ignore: Deno.build.os !== 'linux' || !Deno.env.get('HISTORICAL_UNMOUNTED_ROOT'),
  fn: async () => {
    const temp = Deno.env.get('HISTORICAL_UNMOUNTED_ROOT')!;
    strictEqual(temp.startsWith('/tmp/plex-historical-gate-'), true);
    const snapshot = JSON.parse(await Deno.readTextFile(`${temp}/app/bind-snapshot.json`));
    strictEqual(await historicalRootUnchanged(snapshot), false);
    await Deno.stat(`${temp}/source/episode`);
  },
});

Deno.test({
  name:
    'historical prototype Linux: copies, three links, replacement, symlinks and parent preservation',
  ignore: Deno.build.os !== 'linux',
  fn: async () => {
    const temp = await Deno.makeTempDir({ prefix: 'plex-historical-prototype-' });
    try {
      const root = `${temp}/downloads`;
      const app = `${temp}/app`;
      const nested = `${root}/release/season`;
      await Deno.mkdir(nested, { recursive: true });
      await Deno.mkdir(app);
      const file = `${nested}/episode.mkv`;
      await Deno.writeTextFile(file, 'disposable bytes');
      await Deno.link(file, `${root}/retained-one`);
      await Deno.link(file, `${root}/retained-two`);
      const accepted = await inspectHistoricalFile(file, root, app);
      strictEqual(await historicalRootUnchanged(accepted), true);
      strictEqual(await historicalRootUnchanged({ ...accepted, mount: 'changed mount' }), false);
      const other = await inspectHistoricalFile(`${root}/retained-one`, root, app);
      strictEqual(accepted.inode, other.inode);
      strictEqual(accepted.entry === other.entry, false);
      await unlinkHistoricalFile(accepted, app);
      strictEqual(await historicalRootUnchanged(accepted), true);
      for (
        const path of [
          root,
          `${root}/release`,
          nested,
          `${root}/retained-one`,
          `${root}/retained-two`,
        ]
      ) {
        await Deno.stat(path);
      }
      // Copy qualifies without inspecting or mounting the library.
      await Deno.copyFile(`${root}/retained-one`, file);
      const copied = await inspectHistoricalFile(file, root, app);
      await Deno.rename(file, `${nested}/old`);
      await Deno.copyFile(`${root}/retained-one`, file);
      strictEqual(await historicalFileUnchanged(copied, app), false);
      await rejects(() => unlinkHistoricalFile(copied, app));
      await Deno.symlink(nested, `${root}/alias`);
      await rejects(() => inspectHistoricalFile(`${root}/alias/episode.mkv`, root, app));
      await rejects(() => inspectHistoricalFile(root, root, app));
      await rejects(() => inspectHistoricalFile(file, temp, root));
      await Deno.symlink(app, `${temp}/app-alias`);
      await rejects(() => inspectHistoricalFile(file, root, `${temp}/app-alias`));
      const modified = await inspectHistoricalFile(file, root, app);
      await Deno.utime(file, new Date(0), new Date(0));
      strictEqual(await historicalFileUnchanged(modified, app), false);
    } finally {
      // Only the directory returned by makeTempDir is removed by test teardown.
      await Deno.remove(temp, { recursive: true });
    }
  },
});
