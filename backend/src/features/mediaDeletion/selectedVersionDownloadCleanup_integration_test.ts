import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { resolve } from '@std/path';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import type { PlexMediaVersionPathPreview } from '../../integrations/plex/types.ts';
import { CURRENT_LOCATION_POLICY_VERSION } from '../../../../shared/deletionPolicy.ts';

const directory = await Deno.makeTempDir();
const dbPath = resolve(directory, 'retained.db');
Deno.env.set('DB_PATH', dbPath);
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(dbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { resolveSelectedVersionDownloadCleanup } = await import(
  './selectedVersionDownloadCleanup.ts'
);
const { resolveSeasonDownloadCleanup } = await import('./sonarr/seasonDownloadCleanup.ts');
const {
  resolveDownloadCleanup,
  executeDownloadedFileCleanup,
  persistResolvedCleanupIdentity,
  rehydrateResolvedCleanup,
} = await import('./cleanup.ts');
const { ensureDeletionTarget } = await import('../deletionOperations/workflow/targetWorkflow.ts');
type WorkTarget = Parameters<typeof ensureDeletionTarget>[0];

withTransaction((client) => {
  client.prepare(
    "INSERT INTO servers (id,machine_identifier,name,url,access_token,last_connected_at) VALUES (1,'fixture','Fixture','http://fixture','token',1)",
  ).run();
  client.prepare(
    "INSERT INTO libraries (server_id,key,title,type,synced_at) VALUES (1,'shows','Shows','show',1)",
  ).run();
});

async function fixture() {
  const root = await Deno.makeTempDir({ dir: directory });
  const library = resolve(root, 'library');
  const downloads = resolve(root, 'downloads');
  await Deno.mkdir(library);
  await Deno.mkdir(downloads);
  const payload = resolve(downloads, 'a.mkv');
  const selected = resolve(library, 'a.mkv');
  const retained = resolve(library, 'retained.mkv');
  await Deno.writeTextFile(payload, 'fixture bytes');
  await Deno.link(payload, selected);
  await Deno.writeTextFile(retained, 'another bytes');
  withTransaction((client) => {
    client.exec('DELETE FROM plex_path_mappings');
    for (const [remote, local] of [['/plex', library], ['/retained', downloads]]) {
      client.prepare(`INSERT INTO plex_path_mappings
        (server_id,library_key,plex_path,local_path,case_sensitive,revision,
         validation_plex_path,validation_local_path,validation_size,validated_at,created_at,updated_at)
        VALUES (1,'shows',?,?,1,1,?,?,13,1,1,1)`)
        .run(remote, local, `${remote}/a.mkv`, resolve(local!, 'a.mkv'));
    }
  });
  const job: DownloadJob = {
    id: 'hash',
    name: 'Fixture',
    state: 'uploading',
    size: 13,
    uploaded: 0,
    completedAt: 1,
    ratio: 0,
    seedingTime: 0,
    contentPath: '/downloads/a.mkv',
    savePath: '/downloads',
    trackerHost: null,
    fileCount: 1,
    files: [{ path: 'a.mkv', size: 13 }],
    filesTruncated: false,
    manifestFiles: [{ path: 'a.mkv', size: 13 }],
  };
  let deleted = 0;
  const target: DownloadClientTarget = {
    provider: 'qbittorrent',
    instanceKey: 'fixture',
    configurationIdentity: 'fixture',
    instanceId: null,
    instanceName: 'QB',
    pathMappings: [{
      id: 1,
      qbittorrentPath: '/downloads',
      localPath: downloads,
      caseSensitive: true,
      revision: 1,
    }],
    client: {
      findJob: () => Promise.resolve(job),
      discoverJobs: () => Promise.resolve({ jobs: [job], summaryFingerprint: 'a'.repeat(64) }),
      deleteJob: async () => {
        deleted++;
        await Deno.remove(payload);
      },
    },
  };
  const arr = {
    instanceId: 1,
    instanceName: 'Sonarr',
    instanceType: 'sonarr',
    instanceUrl: 'http://sonarr',
    configurationUpdatedAt: 1,
    mappingIdentity: 'fixture',
    addImportExclusion: false,
    pathMappings: [],
    client: {
      type: 'sonarr',
      lookup: () => Promise.resolve({ id: 1, title: 'Show', path: '/plex', seasons: [] }),
      mediaFiles: () =>
        Promise.resolve([{ id: 1, path: '/plex/a.mkv', relativePath: 'a.mkv', size: 13 }]),
      extraFiles: () => Promise.resolve([]),
      torrentAssociations: () =>
        Promise.resolve([{
          hash: 'hash',
          sourcePath: '/downloads/a.mkv',
          importedPath: '/plex/a.mkv',
        }]),
      downloadIdIsExclusiveTo: () => Promise.resolve(true),
    },
  } as unknown as ArrDeleteTarget;
  const show = { title: 'Show', type: 'show', tmdbId: null, tvdbId: 1 };
  const raw = () => resolveDownloadCleanup('show', show, [arr], [target]);
  const versions = (retainedPath: string): PlexMediaVersionPathPreview[] => [
    {
      mediaId: 1,
      paths: ['/plex/a.mkv'],
      fileSize: 13,
      truncated: false,
      allMediaEntriesRepresented: true,
    },
    {
      mediaId: 2,
      paths: [retainedPath],
      fileSize: 13,
      truncated: false,
      allMediaEntriesRepresented: true,
    },
  ];
  const plan = async (retainedPath = '/plex/retained.mkv') =>
    await resolveSelectedVersionDownloadCleanup({
      serverId: 1,
      libraryKey: 'shows',
      rawCleanup: await raw(),
      liveVersions: versions(retainedPath),
      selectedMediaIds: new Set([1]),
      downloadTargets: [target],
    });
  return {
    root,
    library,
    downloads,
    payload,
    selected,
    retained,
    job,
    target,
    arr,
    show,
    raw,
    versions,
    plan,
    deleted: () => deleted,
  };
}

Deno.test('season current proof scopes history without hiding unresolved selected jobs', async (t) => {
  for (const scenario of ['other season', 'selected unresolved job', 'shared pack'] as const) {
    await t.step(scenario, async () => {
      const f = await fixture();
      await Deno.writeTextFile(resolve(f.downloads, 'b.mkv'), 'another bytes');
      const otherJob: DownloadJob = {
        ...f.job,
        id: 'other',
        contentPath: '/downloads/b.mkv',
        files: [{ path: 'b.mkv', size: 13 }],
        manifestFiles: [{ path: 'b.mkv', size: 13 }],
      };
      const selectedJob: DownloadJob = scenario === 'shared pack'
        ? {
          ...f.job,
          contentPath: '/downloads',
          size: 26,
          fileCount: 2,
          files: [...f.job.files, ...otherJob.files],
          manifestFiles: [...f.job.manifestFiles, ...otherJob.manifestFiles],
        }
        : f.job;
      f.arr.client.torrentAssociations = () =>
        Promise.resolve([
          {
            hash: 'hash',
            sourcePath: '/downloads/a.mkv',
            importedPath: '/plex/a.mkv',
            payloadPath: null,
            historyId: 1,
            date: null,
          },
          {
            hash: 'other',
            sourcePath: '/downloads/b.mkv',
            importedPath: scenario === 'selected unresolved job' ? '/plex/a.mkv' : '/plex/s2.mkv',
            payloadPath: null,
            historyId: 2,
            date: null,
          },
        ]);
      f.target.client.findJob = (id) => Promise.resolve(id === 'hash' ? selectedJob : otherJob);
      f.target.client.discoverJobs = () =>
        Promise.resolve({
          jobs: scenario === 'selected unresolved job' ? [selectedJob, otherJob] : [selectedJob],
          summaryFingerprint: 'a'.repeat(64),
        });
      if (scenario !== 'shared pack') assertEquals((await f.raw()).status, 'resolved');
      const plan = await resolveSeasonDownloadCleanup({
        serverId: 1,
        libraryKey: 'shows',
        showRatingKey: 'show',
        show: f.show,
        arrTargets: [f.arr],
        downloadTargets: [f.target],
        selected: [{ plexPath: '/plex/a.mkv', size: 13 }],
        retained: [{ plexPath: '/plex/retained.mkv', size: 13 }],
        inspect: true,
      });
      if (scenario === 'other season') {
        assertEquals(plan?.status, 'resolved');
        assertEquals(plan?.downloadJobs.map((job) => job.jobId), ['hash']);
      } else {
        assertEquals(plan?.status, 'unavailable');
        assertEquals(plan?.downloadJobs, []);
        assertStringIncludes(
          plan!.reason!,
          scenario === 'shared pack'
            ? 'unselected or unverifiable file'
            : 'associated current qBittorrent payload could not be verified',
        );
      }
      assertEquals(f.deleted(), 0);
      assertEquals(await Deno.readTextFile(resolve(f.downloads, 'b.mkv')), 'another bytes');
    });
  }
});

Deno.test('history-backed version cleanup proves retained entries before accepting or replaying QB deletion', async (t) => {
  await t.step(
    'history match cannot authorize the retained exact payload under another Plex mapping',
    async () => {
      const f = await fixture();
      assertEquals((await f.raw()).status, 'resolved');
      const plan = await f.plan('/retained/a.mkv');
      assertEquals(plan.status, 'unavailable');
      assertStringIncludes(plan.reason!, 'aliases an unselected retained Plex version');
      assertEquals(plan.downloadJobs, []);
      assertEquals(f.deleted(), 0);
      assertEquals(await Deno.readTextFile(f.payload), 'fixture bytes');
    },
  );
  await t.step(
    'season direct retained conflict is not swallowed by resolved import history',
    async () => {
      const f = await fixture();
      const plan = await resolveSeasonDownloadCleanup({
        serverId: 1,
        libraryKey: 'shows',
        showRatingKey: 'show',
        show: f.show,
        arrTargets: [f.arr],
        downloadTargets: [f.target],
        inspect: true,
        selected: [{ plexPath: '/plex/a.mkv', size: 13 }],
        retained: [{ plexPath: '/retained/a.mkv', size: 13 }],
      });
      assertEquals(plan?.status, 'unavailable');
      assertStringIncludes(plan!.reason!, 'aliases an unselected retained Plex version');
      assertEquals(plan!.downloadJobs, []);
    },
  );
  await t.step('a distinct retained hardlink survives accepted persisted cleanup', async () => {
    const f = await fixture();
    await Deno.remove(f.retained);
    await Deno.link(f.payload, f.retained);
    const accepted = await f.plan();
    assertEquals(accepted.status, 'resolved');
    assertEquals(accepted.downloadJobs[0]!.provenance, 'direct_manifest');
    const persisted = persistResolvedCleanupIdentity(accepted);
    const hydrated = rehydrateResolvedCleanup(persisted, [f.target]);
    await executeDownloadedFileCleanup(hydrated, new Set(), new Set());
    assertEquals(f.deleted(), 1);
    assertEquals(await Deno.readTextFile(f.retained), 'fixture bytes');
    assertEquals(await Deno.readTextFile(f.selected), 'fixture bytes');
  });
  await t.step(
    'retained identity drift blocks persisted execution before the QB request',
    async () => {
      const f = await fixture();
      const accepted = persistResolvedCleanupIdentity(await f.plan());
      await Deno.rename(f.retained, resolve(f.library, 'old.mkv'));
      await Deno.writeTextFile(f.retained, 'changed bytes');
      await assertRejects(
        () =>
          executeDownloadedFileCleanup(
            rehydrateResolvedCleanup(accepted, [f.target]),
            new Set(),
            new Set(),
          ),
        Error,
        'retained Plex filesystem identity changed',
      );
      assertEquals(f.deleted(), 0);
    },
  );
  await t.step(
    'matching shared pack cannot use import history to authorize another manifest member',
    async () => {
      const f = await fixture();
      await Deno.writeTextFile(resolve(f.downloads, 'unselected.mkv'), 'unrelated');
      Object.assign(f.job, { contentPath: '/downloads', fileCount: 2, size: 22 });
      f.job.files.push({ path: 'unselected.mkv', size: 9 });
      f.job.manifestFiles.push({ path: 'unselected.mkv', size: 9 });
      const plan = await f.plan();
      assertEquals(plan.status, 'unavailable');
      assertStringIncludes(plan.reason!, 'unselected or unverifiable');
      assertEquals(plan.downloadJobs, []);
    },
  );
  await t.step('missing retained mapping identifies the file that needs access', async () => {
    const f = await fixture();
    const plan = await f.plan('/missing/retained.mkv');
    assertEquals(plan.status, 'unavailable');
    assertStringIncludes(
      plan.reason!,
      'retained Plex path has no single validated local mapping: /missing/retained.mkv',
    );
  });
  await t.step(
    'worker holds already persisted history-only version proofs before any service action',
    async () => {
      const f = await fixture();
      const snapshot = {
        currentLocationPolicyVersion: CURRENT_LOCATION_POLICY_VERSION,
        libraryKey: 'shows',
        ratingKey: 'episode',
        cleanupDownloads: true,
        seasonDownloadCleanup: persistResolvedCleanupIdentity(await f.raw()),
      };
      await assertRejects(
        () =>
          ensureDeletionTarget({
            id: 1,
            operationId: 'test',
            serverId: 1,
            targetKind: 'episode_version',
            targetKey: 'episode:1',
            phase: 'validating',
            snapshot: JSON.stringify(snapshot),
          } as WorkTarget),
        Error,
        'Current selected and retained file evidence is missing',
      );
      assertEquals(f.deleted(), 0);
    },
  );
});
