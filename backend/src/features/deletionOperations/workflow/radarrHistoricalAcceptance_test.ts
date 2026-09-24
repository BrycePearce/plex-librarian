import { assertEquals } from '@std/assert';
import type { ArrDeleteTarget } from '../../arr/delete.ts';
import type { ServiceOwnedPlan } from '../../mediaDeletion/serviceOwnedPlanning.ts';
import type { DownloadClientTarget, DownloadJob } from '../../mediaDeletion/downloadClient.ts';
import type { DeletionWorkTarget } from '../core/types.ts';
import { parseHistoricalImports } from '../../../integrations/arr/historicalImports.ts';
import { planServiceOwnedRetention } from '../../mediaDeletion/serviceOwnedRetention.ts';

Deno.env.set('DB_PATH', ':memory:');
const { withTransaction } = await import('../../../db/index.ts');
const { collectHistoricalDownloads } = await import(
  '../../mediaDeletion/historicalDownloadPlanning.ts'
);
const { discoverHistoricalDownloads } = await import(
  '../../mediaDeletion/serviceOwnedDiscovery.ts'
);
const { ensureHistoricalDownloadPhase } = await import('./historicalDownloadWorkflow.ts');
withTransaction((db) =>
  db.exec(
    'CREATE TABLE servers(id INTEGER PRIMARY KEY); CREATE TABLE arr_instances(id INTEGER PRIMARY KEY); CREATE TABLE deletion_operations(id TEXT PRIMARY KEY); CREATE TABLE deletion_targets(id INTEGER PRIMARY KEY,operation_id TEXT,ordinal INTEGER,snapshot TEXT,status TEXT); CREATE TABLE plex_path_mappings(server_id INTEGER,library_key TEXT,plex_path TEXT,local_path TEXT); CREATE TABLE settings(id INTEGER PRIMARY KEY,active_server_id INTEGER); INSERT INTO settings VALUES(1,1); INSERT INTO servers VALUES(1); INSERT INTO arr_instances VALUES(1);',
  )
);
for (const name of ['0059_tiny_star_brand.sql', '0060_yellow_stature.sql']) {
  for (
    const sql of (await Deno.readTextFile(new URL('../../../../drizzle/' + name, import.meta.url)))
      .split('--> statement-breakpoint')
  ) {
    withTransaction((db) => db.exec(sql));
  }
}

Deno.test({
  name:
    'Radarr Linux exact-file worker: consent ceiling, retained names, QB coverage, missing source and cancellation',
  ignore: Deno.build.os !== 'linux',
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'radarr-historical-acceptance-' });
    try {
      const downloads = root + '/downloads';
      const library = root + '/library';
      await Deno.mkdir(downloads);
      await Deno.mkdir(library);
      await Deno.writeTextFile(downloads + '/Film.mkv', 'fixture');
      await Deno.link(downloads + '/Film.mkv', library + '/Film.mkv');
      const raw = [{
        id: 11,
        movieId: 7,
        eventType: 'downloadFolderImported',
        date: '2021-09-01',
        downloadId: null as string | null,
        data: {
          fileId: '42',
          droppedPath: '/radarr-complete/Film.mkv',
          importedPath: '/movies/Film.mkv',
        },
      }];
      const current = {
        movieId: 7,
        movieFileId: 42,
        files: [{
          id: 42,
          movieId: 7,
          path: '/movies/Film.mkv',
          relativePath: 'Film.mkv',
          size: 7,
        }],
      };
      const arr = [{
        instanceId: 1,
        instanceType: 'radarr',
        instanceUrl: 'http://synthetic.invalid',
        configurationUpdatedAt: 1,
        mappingIdentity: 'fixture',
        pathMappings: [{ kind: 'library', arrPath: '/movies', localPath: library }],
        client: {
          historicalImports: () => Promise.resolve(parseHistoricalImports(raw, 7, 'radarr')),
          radarrMovieSnapshot: () => Promise.resolve(structuredClone(current)),
          downloadIdIsExclusiveTo: () => Promise.resolve(true),
        },
      }] as unknown as ArrDeleteTarget[];
      withTransaction((db) =>
        db.prepare(
          "INSERT INTO historical_download_access(id,server_id,arr_instance_id,configuration,revision,status,sample) VALUES('access',1,1,?,'one','available','/radarr-complete/Film.mkv')",
        ).run(
          JSON.stringify({
            enabled: true,
            remoteRoot: '/radarr-complete',
            localRoot: downloads,
            noRemainingClient: true,
          }),
        )
      );
      const action = {
        id: 'radarr-file',
        service: 'radarr',
        serviceKey: 'arr:1',
        targetId: '42',
        instanceId: 1,
        recordId: 7,
        fileId: 42,
        selected: true,
        presence: 'current',
        effectsComplete: true,
        files: [{ path: '/movies/Film.mkv', size: 7 }],
        entries: [{ id: 'arr:1:/movies/Film.mkv', path: '/movies/Film.mkv' }],
      } as ServiceOwnedPlan['actions'][number];
      const plan = {
        policyVersion: 4,
        serverId: 1,
        libraryKey: 'movies',
        arrSelected: true,
        qbSelected: false,
        selection: { type: 'movie', ratingKey: 'film', mediaId: 42 },
        actions: [action],
        historicalRetainedEntries: [],
        retention: planServiceOwnedRetention({
          actions: [action],
          retainedEntries: [],
          evidenceRevision: 'one',
          qbInventory: 'unconfigured',
        }),
      } as unknown as ServiceOwnedPlan;
      const plans = [plan];
      const qb: DownloadClientTarget[] = [];
      const collect = () => collectHistoricalDownloads(1, plans, arr, qb);
      assertEquals((await collect()).accepted.length, 1);
      plan.historicalRetainedEntries!.push({
        id: 'arr:1:/radarr-complete/Film.mkv',
        path: '/radarr-complete/Film.mkv',
      });
      assertEquals((await collect()).accepted.length, 0);
      plan.historicalRetainedEntries = [];
      // Same source with a replaced import is a conflicting owner, not a second permission.
      raw.push({ ...raw[0], id: 12, data: { ...raw[0].data, fileId: '41' } });
      assertEquals((await collect()).accepted.length, 0);
      raw.pop();
      const discovery = await discoverHistoricalDownloads(1, plans, arr, new Map());
      assertEquals(discovery.scope.length, 1);
      let sequence = 0;
      const run = async (cancelled = false, d = discovery.scope[0]) => {
        const operationId = 'radarr-' + ++sequence;
        withTransaction((db) => {
          db.prepare('INSERT INTO deletion_operations VALUES(?)').run(operationId);
          plans.forEach((p, index) =>
            db.prepare('INSERT INTO deletion_targets VALUES(?,?,?,?,?)').run(
              sequence * 10 + index,
              operationId,
              index,
              JSON.stringify({ serviceOwnedPlan: p }),
              cancelled ? 'cancelled' : 'running',
            )
          );
          db.prepare(
            "INSERT INTO historical_download_journal(id,operation_id,entry,evidence,status) VALUES(?,?,?,?,'pending')",
          ).run(operationId, operationId, 'discovery:' + operationId, JSON.stringify(d));
          db.prepare('INSERT INTO historical_download_reservations VALUES(?,?)').run(
            'discovery:' + operationId,
            operationId,
          );
        });
        const target = { operationId, serverId: 1 } as DeletionWorkTarget;
        const runtime = {
          resolveActiveServer: () =>
            Promise.resolve({ serverId: 1, client: { activeSessions: () => Promise.resolve([]) } }),
          prepare: () => Promise.resolve({ plans, arrTargets: arr, downloadTargets: qb }),
        } as unknown as NonNullable<Parameters<typeof ensureHistoricalDownloadPhase>[1]>;
        await ensureHistoricalDownloadPhase(target, runtime);
        await ensureHistoricalDownloadPhase(target, runtime); // Terminal results never replay.
        return withTransaction((db) =>
          db.prepare('SELECT status,reason FROM historical_download_journal WHERE id=?').value<
            [string, string]
          >(operationId)!
        );
      };
      assertEquals((await run(true))[0], 'skipped');
      assertEquals(await Deno.readTextFile(downloads + '/Film.mkv'), 'fixture');
      withTransaction((db) =>
        db.exec("UPDATE historical_download_access SET revision='changed' WHERE id='access'")
      );
      const changedAccess = await run();
      assertEquals(changedAccess[0], 'skipped');
      assertEquals(changedAccess[1].includes('access changed'), true);
      withTransaction((db) =>
        db.exec("UPDATE historical_download_access SET revision='one' WHERE id='access'")
      );
      const job = {
        id: 'owned',
        savePath: '/qb-complete',
        contentPath: '/qb-complete/Film.mkv',
        fileCount: 1,
        filesTruncated: false,
        manifestFiles: [{ path: 'Film.mkv', size: 7 }],
      } as DownloadJob;
      qb.push({
        instanceKey: 'qb:1',
        provider: 'qbittorrent',
        configurationIdentity: 'one',
        pathMappings: [{ qbittorrentPath: '/qb-complete', localPath: downloads }],
        client: {
          listJobSummaries: () => Promise.resolve([job]),
          findJob: () => Promise.resolve(job),
          deleteJob: () => {
            throw new Error('No service mutation in optional phase');
          },
        },
      } as unknown as DownloadClientTarget);
      assertEquals(
        (await collect()).accepted.length,
        0,
        'unselected current job vetoes local unlink',
      );
      plan.qbSelected = true;
      plan.actions.push({
        id: 'qb-owned',
        service: 'qb',
        serviceKey: 'qb:1',
        instanceKey: 'qb:1',
        targetId: 'owned',
        selected: true,
        presence: 'current',
        effectsComplete: true,
        job,
        files: [{ path: '/qb-complete/Film.mkv', size: 7 }],
        entries: [{ id: 'qb:1:/qb-complete/Film.mkv', path: '/qb-complete/Film.mkv' }],
      });
      plan.retention = planServiceOwnedRetention({
        actions: plan.actions,
        retainedEntries: [],
        evidenceRevision: 'one',
        qbInventory: 'complete',
      });
      const covered = await run();
      assertEquals(covered[0], 'skipped');
      assertEquals(covered[1].includes('removal is not confirmed'), true);
      assertEquals(covered[1].includes('will not run as a fallback'), true);
      const delegation = withTransaction((db) =>
        JSON.parse(
          db.prepare('SELECT validation FROM historical_download_journal WHERE id=?')
            .value<[string]>('radarr-' + sequence)![0],
        )
      );
      assertEquals(delegation.actions.map((a: { actionId: string }) => a.actionId), ['qb-owned']);
      assertEquals(delegation.path, downloads + '/Film.mkv');
      assertEquals(await Deno.readTextFile(downloads + '/Film.mkv'), 'fixture');
      // Equal remote strings in independent Arr namespaces are not the same entry.
      const otherDownloads = root + '/other-downloads';
      await Deno.mkdir(otherDownloads);
      await Deno.writeTextFile(otherDownloads + '/Film.mkv', 'fixture');
      withTransaction((db) => {
        db.exec('INSERT INTO arr_instances VALUES(2)');
        db.prepare(
          "INSERT INTO historical_download_access(id,server_id,arr_instance_id,configuration,revision,status,sample) VALUES('other-access',1,2,?,'one','available','/radarr-complete/Film.mkv')",
        ).run(
          JSON.stringify({
            enabled: true,
            remoteRoot: '/radarr-complete',
            localRoot: otherDownloads,
            noRemainingClient: false,
          }),
        );
      });
      arr.push({ ...arr[0], instanceId: 2 });
      const otherAction = {
        ...action,
        id: 'other-radarr-file',
        instanceId: 2,
        serviceKey: 'arr:2',
        entries: [{ id: 'arr:2:/movies/Film.mkv', path: '/movies/Film.mkv' }],
      };
      plans.push({
        ...plan,
        selection: { ...plan.selection, ratingKey: 'other-film' },
        actions: [otherAction],
        retention: planServiceOwnedRetention({
          actions: [otherAction],
          retainedEntries: [],
          evidenceRevision: 'one',
          qbInventory: 'complete',
        }),
      });
      const otherDiscovery = await discoverHistoricalDownloads(1, plans, arr, new Map());
      const otherScope = otherDiscovery.scope.find((d) => d.instanceId === 2)!;
      assertEquals(
        (await run(false, otherScope))[0],
        'success',
        'QB coverage in instance 1 must not suppress instance 2',
      );
      assertEquals(
        await Deno.stat(otherDownloads + '/Film.mkv').then(() => true, () => false),
        false,
      );
      assertEquals(await Deno.readTextFile(downloads + '/Film.mkv'), 'fixture');
      plans.pop();
      arr.pop();
      qb.length = 0;
      plan.actions.pop();
      plan.qbSelected = false;
      plan.retention = planServiceOwnedRetention({
        actions: plan.actions,
        retainedEntries: [],
        evidenceRevision: 'one',
        qbInventory: 'unconfigured',
      });
      // Execution discovers another eligible source, but it was never reviewed.
      await Deno.writeTextFile(downloads + '/Unreviewed.mkv', 'fixture');
      raw.push({
        ...raw[0],
        id: 13,
        data: { ...raw[0].data, droppedPath: '/radarr-complete/Unreviewed.mkv' },
      });
      assertEquals((await run())[0], 'success');
      assertEquals(
        await Deno.readTextFile(library + '/Film.mkv'),
        'fixture',
        'other hardlink names survive',
      );
      assertEquals(
        await Deno.readTextFile(downloads + '/Unreviewed.mkv'),
        'fixture',
        'reviewed scope is a ceiling',
      );
      assertEquals(
        (await run())[0],
        'skipped',
        'missing before filesystem acceptance is not claimed as deleted',
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
