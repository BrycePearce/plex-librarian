import { deepStrictEqual, strictEqual } from 'node:assert';
import type { ArrDeleteTarget } from '../../arr/delete.ts';
import type { ServiceOwnedPlan } from '../../mediaDeletion/serviceOwnedPlanning.ts';
import type {
  DownloadClientTarget,
  DownloadJob,
  DownloadJobSummary,
} from '../../mediaDeletion/downloadClient.ts';
import type { HistoricalImportEvidence } from '../../../integrations/arr/historicalImports.ts';
import type { SonarrSeriesSnapshot } from '../../../integrations/arr/client.ts';
import type { DeletionWorkTarget } from '../core/types.ts';

Deno.env.set('DB_PATH', ':memory:');
const { withTransaction } = await import('../../../db/index.ts');
const { collectHistoricalDownloads, historicalOwnerContexts } = await import(
  '../../mediaDeletion/historicalDownloadPlanning.ts'
);
const { ensureHistoricalDownloadPhase } = await import('./historicalDownloadWorkflow.ts');
const { executeServiceOwnedActions } = await import('./serviceOwnedWorkflow.ts');
const { planServiceOwnedRetention } = await import('../../mediaDeletion/serviceOwnedRetention.ts');
withTransaction((db) =>
  db.exec(
    'CREATE TABLE servers(id INTEGER PRIMARY KEY); CREATE TABLE arr_instances(id INTEGER PRIMARY KEY); CREATE TABLE deletion_operations(id TEXT PRIMARY KEY); CREATE TABLE deletion_targets(id INTEGER PRIMARY KEY,operation_id TEXT,ordinal INTEGER,snapshot TEXT,status TEXT); CREATE TABLE plex_path_mappings(server_id INTEGER,library_key TEXT,plex_path TEXT,local_path TEXT); INSERT INTO servers VALUES(1); INSERT INTO arr_instances VALUES(1),(2);',
  )
);
for (
  const sql of (await Deno.readTextFile(
    new URL('../../../../drizzle/0059_tiny_star_brand.sql', import.meta.url),
  )).split('--> statement-breakpoint')
) {
  withTransaction((db) => db.exec(sql));
}
const validationMigration = await Deno.readTextFile(
  new URL('../../../../drizzle/0060_yellow_stature.sql', import.meta.url),
);
withTransaction((db) => db.exec(validationMigration));
withTransaction((db) =>
  db.exec(
    'CREATE TABLE settings(id INTEGER PRIMARY KEY,active_server_id INTEGER); INSERT INTO settings VALUES(1,1)',
  )
);

Deno.test({
  name:
    'native collector and durable optional phase: 100-file season, shared contexts, retained aliases, new job, replacement, bounded large manifest',
  ignore: Deno.build.os !== 'linux',
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'historical-season-' });
    try {
      const downloads = root + '/downloads';
      const library = root + '/library';
      await Deno.mkdir(downloads);
      await Deno.mkdir(library);
      let historyReads = 0;
      let seriesReads = 0;
      let inventories = 0;
      let manifests = 0;
      let prepares = 0;
      const history: HistoricalImportEvidence = { records: [], problems: [] };
      const current: SonarrSeriesSnapshot = { files: [], episodes: [] };
      for (let index = 1; index <= 103; index++) {
        const name = index + '.mkv';
        const source = downloads + '/' + name;
        const path = library + '/' + name;
        await Deno.writeTextFile(source, 'fixture');
        if (index % 2) await Deno.link(source, path);
        else await Deno.writeTextFile(path, 'fixture');
        if (index === 1) await Deno.link(source, root + '/third-link');
        current.files.push({
          id: index,
          seriesId: 701,
          path: '/library/' + name,
          size: 7,
          episodeIds: [index],
          relativePath: name,
        });
        current.episodes.push({
          id: index,
          seriesId: 701,
          episodeFileId: index,
          seasonNumber: index <= 102 ? 3 : 4,
          episodeNumber: index,
          monitored: true,
        });
        history.records.push({
          historyId: index,
          seriesId: 701,
          fileId: index,
          episodeId: index,
          importedPath: '/library/' + name,
          droppedPath: '/downloads/' + name,
          size: 7,
          date: '2026-01-01',
          downloadId: null,
        });
      }
      // A second service namespace maps the same exact directory entry and owns it too.
      const otherHistory = structuredClone(history);
      otherHistory.records = [{
        ...history.records[0],
        seriesId: 702,
        droppedPath: '/alias/1.mkv',
      }];
      const otherCurrent = {
        files: [{ ...current.files[0], seriesId: 702 }],
        episodes: [{ ...current.episodes[0], seriesId: 702 }],
      };
      const target = (
        instanceId: number,
        evidence: HistoricalImportEvidence,
        inventory: SonarrSeriesSnapshot,
      ): ArrDeleteTarget => ({
        instanceId,
        instanceName: 'mock Sonarr',
        instanceType: 'sonarr',
        instanceUrl: 'http://fixture.invalid',
        configurationUpdatedAt: 1,
        mappingIdentity: 'fixture',
        addImportExclusion: false,
        pathMappings: [{ kind: 'library', arrPath: '/library', localPath: library }],
        client: {
          historicalImports: () => {
            historyReads++;
            return Promise.resolve(structuredClone(evidence));
          },
          sonarrSeriesSnapshot: () => {
            seriesReads++;
            return Promise.resolve(structuredClone(inventory));
          },
          sonarrEpisodeFileOwnerIds: (id: number) =>
            Promise.resolve(
              inventory.episodes.filter((e) => e.episodeFileId === id).map((e) => e.id),
            ),
          sonarrEpisodeFile: (id: number) =>
            Promise.resolve(inventory.files.find((f) => f.id === id) ?? null),
        } as unknown as ArrDeleteTarget['client'],
      });
      const arr = [target(1, history, current), target(2, otherHistory, otherCurrent)];
      for (const [id, remoteRoot] of [[1, '/downloads'], [2, '/alias']] as const) {
        withTransaction((db) =>
          db.prepare(
            "INSERT INTO historical_download_access(id,server_id,arr_instance_id,configuration,revision,status,sample) VALUES(?,1,?,?,?,'available',?)",
          )
            .run(
              String(id),
              id,
              JSON.stringify({
                enabled: true,
                remoteRoot,
                localRoot: downloads,
                noRemainingClient: false,
              }),
              'revision',
              remoteRoot + '/1.mkv',
            )
        );
      }
      const plan = (instanceId: number, inventory: SonarrSeriesSnapshot): ServiceOwnedPlan => ({
        policyVersion: 4,
        serverId: 1,
        libraryKey: 'tv',
        arrSelected: true,
        qbSelected: false,
        connections: [],
        fingerprint: 'fixture',
        plexFiles: [],
        evidenceRevision: 'fixture',
        selection: {
          ratingKey: String(instanceId),
          title: 'Synthetic season fixture',
          type: 'season',
          seasonIndex: 3,
          tvdbId: 42,
          tmdbId: null,
        },
        historicalRetainedEntries: instanceId === 1
          ? [{ id: 'plex:retained:/plex-alias/102.mkv', path: '/plex-alias/102.mkv' }]
          : [],
        actions: inventory.files.filter((f) => f.id <= 102).map((f) => ({
          id: instanceId + ':' + f.id,
          service: 'sonarr',
          serviceKey: 'arr:' + instanceId,
          targetId: String(f.id),
          instanceId,
          recordId: f.seriesId,
          fileId: f.id,
          presence: 'current',
          effectsComplete: true,
          files: [{ path: f.path, size: f.size }],
          entries: [{ id: 'arr:' + instanceId + ':' + f.path, path: f.path }],
        })),
        retention: { decisions: [] } as unknown as ServiceOwnedPlan['retention'],
      });
      const plans = [plan(1, current), plan(2, otherCurrent)];
      withTransaction((db) =>
        db.exec(
          "INSERT INTO plex_path_mappings VALUES(1,'retained','/plex-alias','" + downloads +
            "'),(2,'retained','/other','/wrong');",
        )
      );
      let newJob = false;
      let lateJobName: string | null = null;
      const largeJob: DownloadJob = {
        id: 'large',
        name: 'unrelated files in same root',
        state: 'stopped',
        size: 1,
        uploaded: 0,
        completedAt: 1,
        ratio: 0,
        seedingTime: 0,
        contentPath: '/downloads/other',
        savePath: '/downloads',
        trackerHost: null,
        fileCount: 10000,
        files: [],
        filesTruncated: false,
        manifestFiles: Array.from(
          { length: 10000 },
          (_, i) => ({ path: 'unrelated/' + i, size: 1 }),
        ),
      };
      const qb: DownloadClientTarget[] = [{
        provider: 'qbittorrent',
        instanceKey: 'qb:1',
        instanceId: 1,
        instanceName: 'mock QB',
        configurationIdentity: 'fixture',
        pathMappings: [{
          id: 1,
          revision: 1,
          caseSensitive: true,
          qbittorrentPath: '/downloads',
          localPath: downloads,
        }],
        client: {
          scanJobSummaries: async (visit: (s: DownloadJobSummary) => Promise<void>) => {
            inventories++;
            await visit(largeJob);
            if (newJob) {
              await visit({ ...largeJob, id: 'new', contentPath: '/downloads/100.mkv' });
            }
            if (lateJobName && inventories >= 3) {
              await visit({ ...largeJob, id: 'late', contentPath: '/downloads/' + lateJobName });
            }
            return 'fixture';
          },
          findJob: (id: string) => {
            manifests++;
            return Promise.resolve(
              id === 'large' ? largeJob : {
                ...largeJob,
                id,
                fileCount: 1,
                manifestFiles: [{ path: id === 'late' ? lateJobName! : '100.mkv', size: 7 }],
              },
            );
          },
          deleteJob: () => {
            throw new Error('Optional cleanup must never mutate QB');
          },
        },
      }];
      const preview = await collectHistoricalDownloads(1, plans, arr, qb);
      strictEqual(preview.accepted.length, 101); // 1..101, with 102 retained and 103 outside selection.
      strictEqual(preview.preview.skipped.some((s) => s.source === '/downloads/102.mkv'), true);
      const shared = preview.accepted.find((c) => c.lineage.source.endsWith('/1.mkv'))!;
      strictEqual(historicalOwnerContexts(shared).length, 2);
      strictEqual(preview.preview.candidates.find((c) => c.id === shared.id)!.ownerCount, 2);
      // Planner-produced retained entries use the Arr connection namespace,
      // including claims outside the separately fetched current series.
      arr[0].pathMappings.push({
        kind: 'library',
        arrPath: '/retained-other-series',
        localPath: downloads,
      });
      plans[0].historicalRetainedEntries!.push({
        id: 'arr:1:/retained-other-series/101.mkv',
        path: '/retained-other-series/101.mkv',
      });
      const retainedArr = await collectHistoricalDownloads(1, plans, arr, qb);
      strictEqual(
        retainedArr.accepted.some((c) => c.lineage.source === '/downloads/101.mkv'),
        false,
        'Planner Arr entry keys must preserve retained aliases outside the current series',
      );
      plans[0].historicalRetainedEntries!.pop();
      arr[0].pathMappings.pop();
      await Deno.symlink(downloads, root + '/retained-alias');
      withTransaction((db) =>
        db.prepare(
          "UPDATE plex_path_mappings SET local_path=? WHERE server_id=1 AND library_key='retained'",
        )
          .run(root + '/retained-alias')
      );
      const retainedSymlink = await collectHistoricalDownloads(1, plans, arr, qb);
      strictEqual(
        retainedSymlink.accepted.some((c) => c.lineage.source === '/downloads/102.mkv'),
        false,
        'An existing retained symlink alias must veto the historical entry',
      );
      const aliasJob = {
        ...largeJob,
        id: 'alias-job',
        savePath: '/qb-downloads',
        contentPath: '/qb-downloads/101.mkv',
        fileCount: 1,
        manifestFiles: [{ path: '101.mkv', size: 7 }],
      };
      const aliasClient: DownloadClientTarget = {
        ...qb[0],
        pathMappings: [{
          id: 1,
          revision: 1,
          caseSensitive: true,
          qbittorrentPath: '/qb-downloads',
          localPath: root + '/retained-alias',
        }],
        client: {
          ...qb[0].client,
          scanJobSummaries: async (visit) => {
            await visit(aliasJob);
            return 'alias-fixture';
          },
          findJob: () => Promise.resolve(aliasJob),
        },
      };
      const unmappedQb = await collectHistoricalDownloads(1, plans, arr, [{
        ...aliasClient,
        pathMappings: [],
      }]);
      strictEqual(
        unmappedQb.accepted.length,
        0,
        'Different unmapped QB namespaces cannot establish absence of current ownership',
      );
      const qbSymlink = await collectHistoricalDownloads(1, plans, arr, [aliasClient]);
      strictEqual(
        qbSymlink.accepted.some((c) => c.lineage.source === '/downloads/101.mkv'),
        false,
        'A current job under a mapped symlink root must veto the source',
      );
      await Deno.mkdir(root + '/jobroot');
      await Deno.symlink(downloads, root + '/jobroot/release');
      aliasClient.pathMappings![0].localPath = root + '/jobroot';
      aliasJob.savePath = '/qb-downloads/release';
      aliasJob.contentPath = '/qb-downloads/release/101.mkv';
      const nestedQb = await collectHistoricalDownloads(1, plans, arr, [aliasClient]);
      strictEqual(nestedQb.accepted.some((c) => c.lineage.source === '/downloads/101.mkv'), false);
      await Deno.symlink(downloads + '/101.mkv', root + '/jobroot/101.mkv');
      aliasJob.savePath = '/qb-downloads';
      aliasJob.contentPath = '/qb-downloads/101.mkv';
      const fileQb = await collectHistoricalDownloads(1, plans, arr, [aliasClient]);
      strictEqual(
        fileQb.accepted.some((c) => c.lineage.source === '/downloads/101.mkv'),
        false,
        'A current job exact-file symlink must protect its regular historical source',
      );
      withTransaction((db) =>
        db.prepare(
          "UPDATE plex_path_mappings SET local_path=? WHERE server_id=1 AND library_key='retained'",
        )
          .run(downloads)
      );
      // A fully unselected owner in an alias context must veto the selected namespace.
      otherCurrent.episodes[0].seasonNumber = 4;
      const partial = await collectHistoricalDownloads(1, plans, arr, qb);
      strictEqual(
        partial.accepted.some((c) => c.filesystem.entry === shared.filesystem.entry),
        false,
      );
      withTransaction((db) =>
        db.exec(
          "UPDATE historical_download_access SET configuration=json_set(configuration,'$.enabled',json('false')) WHERE id='2'",
        )
      );
      const disabledOwner = await collectHistoricalDownloads(1, plans, arr, qb);
      strictEqual(
        disabledOwner.accepted.some((c) => c.filesystem.entry === shared.filesystem.entry),
        false,
        'Disabling cleanup must not erase the alias evidence of an unselected owner',
      );
      withTransaction((db) =>
        db.prepare(
          "UPDATE historical_download_access SET configuration=json_set(configuration,'$.localRoot',?) WHERE id='2'",
        ).run(root + '/retained-alias')
      );
      const disabledSymlinkOwner = await collectHistoricalDownloads(1, plans, arr, qb);
      strictEqual(
        disabledSymlinkOwner.accepted.some((c) => c.filesystem.entry === shared.filesystem.entry),
        false,
        'An unselected historical owner through a saved symlink root must veto the physical source',
      );
      withTransaction((db) =>
        db.prepare(
          "UPDATE historical_download_access SET configuration=json_set(configuration,'$.localRoot',?) WHERE id='2'",
        ).run(downloads)
      );
      withTransaction((db) =>
        db.exec(
          "UPDATE historical_download_access SET configuration=json_set(configuration,'$.enabled',json('true')) WHERE id='2'",
        )
      );
      otherCurrent.episodes[0].seasonNumber = 3;
      // A failed read cannot hide another owner of the same physical source.
      const originalRead = arr[1].client.sonarrSeriesSnapshot;
      arr[1].client.sonarrSeriesSnapshot = () =>
        Promise.reject(new Error('Unavailable owner inventory'));
      const unavailable = await collectHistoricalDownloads(1, plans, arr, qb);
      strictEqual(unavailable.accepted.length, 0);
      strictEqual(
        unavailable.preview.skipped.some((s) =>
          s.reason.includes('unavailable history or ownership')
        ),
        true,
      );
      arr[1].client.sonarrSeriesSnapshot = originalRead;
      // Report preview + operation counts separately from the partial-selection probe.
      historyReads = 2;
      seriesReads = 2;
      inventories = 1;
      manifests = 1;
      // Changes after preview: the current job and replacement must veto their old evidence.
      newJob = true;
      current.files[98].size = 8;
      plans[0].historicalRetainedEntries!.push({
        id: 'plex:retained:/plex-alias/101.mkv',
        path: '/plex-alias/101.mkv',
      });
      const operationId = 'season';
      withTransaction((db) => {
        db.prepare('INSERT INTO deletion_operations VALUES(?)').run(operationId);
        plans.forEach((p, index) =>
          db.prepare('INSERT INTO deletion_targets VALUES(?,?,?,?,?)').run(
            index + 1,
            operationId,
            index,
            JSON.stringify({ serviceOwnedPlan: p }),
            'running',
          )
        );
        preview.accepted.forEach((c) => {
          db.prepare(
            "INSERT INTO historical_download_journal(id,operation_id,entry,evidence,status) VALUES(?,?,?,?,'pending')",
          ).run(c.id, operationId, c.filesystem.entry, JSON.stringify(c));
          db.prepare('INSERT INTO historical_download_reservations VALUES(?,?)').run(
            c.filesystem.entry,
            c.id,
          );
        });
      });
      // Real asynchronous mock latency, rather than advancing a fake clock:
      // preparation alone exceeds the retired two-second rejection deadline.
      for (const service of arr) {
        const owners = service.client.sonarrEpisodeFileOwnerIds.bind(service.client);
        service.client.sonarrEpisodeFileOwnerIds = async (...args) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return await owners(...args);
        };
      }
      const scanJobs = qb[0].client.scanJobSummaries!;
      qb[0].client.scanJobSummaries = async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return await scanJobs(...args);
      };
      const runtime = {
        resolveActiveServer: () =>
          Promise.resolve({
            serverId: 1,
            client: {
              activeSessions: async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
                return [];
              },
            },
          }),
        prepare: async () => {
          prepares++;
          await new Promise((resolve) => setTimeout(resolve, 2100));
          return { plans, arrTargets: arr, downloadTargets: qb };
        },
      } as unknown as NonNullable<Parameters<typeof ensureHistoricalDownloadPhase>[1]>;
      const work = { operationId, serverId: 1 } as DeletionWorkTarget;
      const lateCandidate = [...preview.accepted].sort((a, b) => a.id.localeCompare(b.id))
        .slice(30).find((c) => Number(c.lineage.source.split('/').pop()!.split('.')[0]) < 99)!;
      lateJobName = lateCandidate.lineage.source.split('/').pop()!;
      await ensureHistoricalDownloadPhase(work, runtime);
      const validations = withTransaction((db) =>
        db.prepare(
          "SELECT validation,CAST(intent_at AS REAL) FROM historical_download_journal WHERE status='success'",
        ).values<[string, number]>()
      );
      for (const [json, intentAt] of validations) {
        const validation = JSON.parse(json);
        strictEqual(validation.observedAt > 1_000_000_000_000, true);
        strictEqual(validation.validatedAt >= validation.observedAt, true);
        strictEqual(validation.validatedAt <= intentAt, true);
        strictEqual(validation.evaluation >= 1 && validation.evaluation <= 10, true);
        strictEqual(/^[a-f0-9]{64}$/.test(validation.checkpointFingerprint), true);
      }
      const outcomes = withTransaction((db) =>
        db.prepare('SELECT status,COUNT(*) FROM historical_download_journal GROUP BY status')
          .values<[string, number]>()
      );
      deepStrictEqual(Object.fromEntries(outcomes), { changed: 4, success: 97 });
      const beforeRetry = { prepares, inventories, manifests };
      await ensureHistoricalDownloadPhase(work, runtime);
      deepStrictEqual({ prepares, inventories, manifests }, beforeRetry);
      strictEqual(historyReads, 4); // Two preview contexts + two operation contexts, not one per file.
      strictEqual(prepares, 1, 'One slow full preparation must serve the whole season');
      strictEqual(
        seriesReads,
        4,
        'Series inventory is shared across execution, not rebuilt per batch',
      );
      strictEqual(inventories <= 13, true, 'complete summaries shared over each checkpoint');
      strictEqual(
        manifests <= 35,
        true,
        'manifests shared over each checkpoint, including new jobs',
      );
      for (let index = 1; index <= 103; index++) {
        const exists = await Deno.stat(downloads + '/' + index + '.mkv').then(
          () => true,
          () => false,
        );
        strictEqual(
          exists,
          index >= 99 || index + '.mkv' === lateJobName,
          'historical source ' + index,
        );
        strictEqual((await Deno.stat(library + '/' + index + '.mkv')).isFile, true);
      }
      // Cancellation while preparing cannot proceed to unlink; recovery never replays intent.
      const remaining = preview.accepted.find((c) => c.lineage.source === '/downloads/100.mkv')!;
      for (
        const [scenarioIndex, scenario] of ['cancel', 'configuration', 'intent']
          .entries()
      ) {
        const originalOwners = arr[0].client.sonarrEpisodeFileOwnerIds;
        if (scenario === 'configuration') {
          newJob = false;
          arr[0].client.sonarrEpisodeFileOwnerIds = async (...args) => {
            const owners = await originalOwners(...args);
            // A saved access edit arrives while the final current-owner read is pending.
            withTransaction((db) =>
              db.prepare(
                "UPDATE historical_download_access SET revision='disabled-during-validation',configuration=json_set(configuration,'$.enabled',json('false')) WHERE id='1'",
              ).run()
            );
            return owners;
          };
        }
        const id = scenario + remaining.id;
        withTransaction((db) => {
          db.prepare('INSERT INTO deletion_operations VALUES(?)').run(scenario);
          db.prepare('INSERT INTO deletion_targets VALUES(?,?,?,?,?)').run(
            scenarioIndex + 3,
            scenario,
            0,
            JSON.stringify({ serviceOwnedPlan: plans[0] }),
            'running',
          );
          db.prepare(
            'INSERT INTO historical_download_journal(id,operation_id,entry,evidence,status) VALUES(?,?,?,?,?)',
          ).run(
            id,
            scenario,
            remaining.filesystem.entry,
            JSON.stringify(remaining),
            scenario === 'intent' ? 'intent' : 'pending',
          );
          db.prepare('INSERT INTO historical_download_reservations VALUES(?,?)').run(
            remaining.filesystem.entry,
            id,
          );
        });
        const cancelling = {
          ...runtime,
          prepare: async (...args: Parameters<typeof runtime.prepare>) => {
            if (scenario === 'cancel') {
              withTransaction((db) =>
                db.prepare("UPDATE deletion_targets SET status='cancelled' WHERE operation_id=?")
                  .run(
                    scenario,
                  )
              );
            }
            return await runtime.prepare(...args);
          },
        };
        await ensureHistoricalDownloadPhase(
          { operationId: scenario, serverId: 1 } as DeletionWorkTarget,
          cancelling,
        );
        strictEqual(
          withTransaction((db) =>
            db.prepare('SELECT status FROM historical_download_journal WHERE id=?').value<[string]>(
              id,
            )
          )![0],
          scenario === 'intent' ? 'uncertain' : 'skipped',
        );
        strictEqual((await Deno.stat(downloads + '/100.mkv')).isFile, true);
        if (scenario === 'configuration') {
          arr[0].client.sonarrEpisodeFileOwnerIds = originalOwners;
          newJob = true;
          withTransaction((db) =>
            db.prepare(
              "UPDATE historical_download_access SET revision='revision',configuration=json_set(configuration,'$.enabled',json('true')) WHERE id='1'",
            ).run()
          );
        }
      }
      // Mocked native service effects run through the production durable action executor.
      const actions = plans[0].actions.map((a) => ({ ...a, selected: true }));
      const servicePlan = {
        actions,
        retention: planServiceOwnedRetention({
          actions,
          retainedEntries: [],
          evidenceRevision: 'fixture',
          qbInventory: 'unconfigured',
        }),
      };
      const attempts: Record<string, import('./serviceOwnedWorkflow.ts').ServiceOwnedAttempt> = {};
      let serviceCalls = 0;
      const serviceRuntime = {
        save() {},
        revalidate: () => Promise.resolve(),
        present: (action: typeof actions[number]) =>
          Deno.stat(library + '/' + action.fileId + '.mkv').then(() => true, () => false),
        mutate: async (
          action: typeof actions[number],
          record: (r: { status: 'accepted'; httpStatus: number }) => void,
        ) => {
          serviceCalls++;
          await Deno.remove(library + '/' + action.fileId + '.mkv');
          record({ status: 'accepted', httpStatus: 200 });
        },
      };
      await executeServiceOwnedActions(servicePlan, attempts, serviceRuntime);
      await executeServiceOwnedActions(servicePlan, attempts, serviceRuntime);
      strictEqual(serviceCalls, 102);
      for (let index = 1; index <= 102; index++) {
        strictEqual(
          await Deno.stat(library + '/' + index + '.mkv').then(() => true, () => false),
          false,
        );
      }
      strictEqual((await Deno.stat(library + '/103.mkv')).isFile, true);
      console.info(
        JSON.stringify({
          historyReads,
          seriesReads,
          inventories,
          manifests,
          prepares,
          historicalSuccesses: 97,
          serviceCalls,
        }),
      );
      strictEqual((await Deno.stat(root + '/third-link')).isFile, true);
      strictEqual((await Deno.stat(downloads)).isDirectory, true);
      strictEqual((await Deno.stat(library)).isDirectory, true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
