import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { resolve } from '@std/path';
import { CURRENT_LOCATION_POLICY_VERSION } from '../../../../shared/deletionPolicy.ts';

const directory = await Deno.makeTempDir();
const dbPath = resolve(directory, 'upgrade.db');
Deno.env.set('DB_PATH', dbPath);
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(dbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const {
  cancelDeletionOperation,
  dismissDeletionOperation,
  getDeletionOperation,
  retryDeletionOperation,
  recheckPlexReconciliationAfterSync,
  runDeletionWorkerOnceForTest,
  setAutomaticDeletionWorkerForTest,
  repeatedDeletionOperation,
} = await import('./service.ts');
const { holdLegacyDeletionTargets, upgradeTargetCanCancel } = await import(
  './core/upgradePolicy.ts'
);
const { recoverInterruptedDeletionWork } = await import('./core/recovery.ts');
const { ensureDeletionTarget } = await import('./workflow/targetWorkflow.ts');
const { validateArrMonitoringEvidence } = await import('./core/validation.ts');
setAutomaticDeletionWorkerForTest(false);

Deno.test('legacy upgrade gates every replay and cancels only mutation-free targets atomically', async () => {
  const historicalFile = resolve(directory, 'old-import.mkv');
  await Deno.writeTextFile(historicalFile, 'preserve historical bytes');
  const hash = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{}'))),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO servers (id,machine_identifier,name,url,access_token,last_connected_at) VALUES (1,'fixture','Fixture','http://fixture','token',1)",
    ).run();
    client.prepare("INSERT INTO settings (id,client_id,active_server_id) VALUES (1,'fixture',1)")
      .run();
    client.prepare(
      "INSERT INTO libraries (server_id,key,title,type,synced_at) VALUES (1,'movies','Movies','movie',1)",
    ).run();
    client.prepare(
      "INSERT INTO deletion_operations (id,client_request_id,request_hash,server_id,library_key,kind,status,target_count,created_at,updated_at) VALUES ('legacy','request',?,1,'movies','movie_version','running',10,1,1)",
    ).run(hash);
    for (let id = 1; id <= 10; id++) {
      client.prepare(
        "INSERT INTO items (server_id,rating_key,library_key,title,type,updated_at) VALUES (1,?,'movies','Fixture','movie',1)",
      ).run(String(id));
      const snapshot: Record<string, unknown> = {
        ratingKey: String(id),
        libraryKey: 'movies',
        type: 'movie',
        wholeItemDownloadCleanup: { orphanFiles: [{ path: historicalFile }], downloadJobs: [] },
      };
      if (id === 7) snapshot.arrReassignments = [{ sonarrTransition: { payloadProtectionAt: 5 } }];
      if (id === 8) snapshot.radarrRemovalFallback = { transition: { removalAttemptedAt: 5 } };
      client.prepare(
        `INSERT INTO deletion_targets (id,operation_id,ordinal,target_kind,target_key,title,snapshot,status,phase,attempt_count,plex_attempt_count,created_at,updated_at)
        VALUES (?,'legacy',?,'movie_version',?,'Fixture',?,?,?, ?,?,1,1)`,
      ).run(
        id,
        id,
        String(id),
        id === 9 ? '{broken' : JSON.stringify(snapshot),
        id === 10
          ? 'completed'
          : id === 2
          ? 'needs_attention'
          : id === 3
          ? 'waiting_retry'
          : 'running',
        id === 10 ? 'finalizing' : id === 3 ? 'plex_reconciliation' : 'validating',
        id === 2 ? 4 : 0,
        id === 3 ? 1 : 0,
      );
      client.prepare(
        "INSERT INTO media_version_reservations (server_id,media_kind,media_id,rating_key,operation_id,target_id,created_at) VALUES (1,'movie',?,?,'legacy',?,1)",
      ).run(id, String(id), id);
    }
    client.prepare(
      "INSERT INTO torrent_delete_attempts (server_id,rating_key,instance_key,torrent_hash,started_at) VALUES (1,'4','fixture','hash',1)",
    ).run();
    client.prepare(
      "INSERT INTO download_file_delete_attempts (server_id,rating_key,local_path,root_path,root_device,root_inode,started_at) VALUES (1,'5',?,'/fixture','1','1',1)",
    ).run(historicalFile);
    client.prepare(
      "INSERT INTO arr_instances (id,server_id,type,name,url,api_key,created_at,updated_at) VALUES (1,1,'radarr','Fixture','http://fixture','key',1,1)",
    ).run();
    client.prepare(
      "INSERT INTO arr_delete_attempts (server_id,rating_key,library_key,arr_instance_id,external_id,started_at) VALUES (1,'6','movies',1,6,1)",
    ).run();
    for (const targetId of [1, 3]) {
      client.prepare(
        "INSERT INTO radarr_movie_reservations (server_id,arr_instance_id,movie_id,operation_id,target_id,plan_fingerprint,created_at,updated_at) VALUES (1,1,?,'legacy',?,'fixture',1,1)",
      ).run(targetId, targetId);
    }
    holdLegacyDeletionTargets(client, 20);
    recoverInterruptedDeletionWork(client, 21);
    assertEquals(
      client.prepare('SELECT id FROM deletion_targets WHERE status = ? ORDER BY id').values(
        'needs_attention',
      ),
      [[1], [2], [3], [4], [5], [6], [7], [8], [9]],
    );
    assertEquals(
      client.prepare('SELECT attempt_count FROM deletion_targets WHERE id = 2').value(),
      [4],
    );
    assertEquals(
      client.prepare('SELECT status,snapshot FROM deletion_targets WHERE id = 10').value()?.[0],
      'completed',
    );
    assertEquals(upgradeTargetCanCancel(client, 1), true);
    assertEquals(upgradeTargetCanCancel(client, 2), true);
    for (let id = 3; id <= 9; id++) assertEquals(upgradeTargetCanCancel(client, id), false);
  });
  let externalCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    externalCalls++;
    throw new Error('Unexpected external call');
  }) as typeof fetch;
  try {
    assertEquals(retryDeletionOperation('legacy', 1), false);
    assertEquals(recheckPlexReconciliationAfterSync(1, 'movies'), 0);
    assertEquals(dismissDeletionOperation('legacy', 1), false);
    await runDeletionWorkerOnceForTest();
    await assertRejects(
      () =>
        ensureDeletionTarget({
          id: 3,
          operationId: 'legacy',
          serverId: 1,
          targetKind: 'movie_version',
          targetKey: '3',
          snapshot: '{}',
          logicalSize: null,
          phase: 'plex_reconciliation',
          removalConfirmedAt: null,
          plexAttemptCount: 1,
        }),
      Error,
      'paused after update',
    );
    assertEquals(externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(cancelDeletionOperation('legacy', 1), true);
  assertEquals(cancelDeletionOperation('legacy', 1), false);
  const detail = getDeletionOperation('legacy', 1)!;
  const detailTargets = detail.targets as Array<Record<string, unknown>>;
  assertEquals(detailTargets.find((target) => target.id === 9)?.upgradeHold, true);
  assertEquals(detailTargets.find((target) => target.id === 9)?.upgradeHoldCancellable, false);
  withTransaction((client) => {
    assertEquals(
      client.prepare("SELECT id FROM deletion_targets WHERE status = 'cancelled' ORDER BY id")
        .values(),
      [[1], [2]],
    );
    assertEquals(
      client.prepare('SELECT target_id FROM media_version_reservations ORDER BY target_id')
        .values(),
      [[3], [4], [5], [6], [7], [8], [9], [10]],
    );
    assertEquals(
      client.prepare('SELECT attempt_count FROM deletion_targets WHERE id = 2').value(),
      [4],
    );
    assertEquals(client.prepare('SELECT COUNT(*) FROM torrent_delete_attempts').value(), [1]);
    assertEquals(client.prepare('SELECT COUNT(*) FROM download_file_delete_attempts').value(), [1]);
    assertEquals(client.prepare('SELECT COUNT(*) FROM arr_delete_attempts').value(), [1]);
    assertEquals(client.prepare('SELECT target_id FROM radarr_movie_reservations').values(), [[3]]);
    assertEquals(client.prepare('SELECT snapshot FROM deletion_targets WHERE id = 9').value(), [
      '{broken',
    ]);
  });
  assertEquals((await repeatedDeletionOperation(1, 'request', {}))?.operationId, 'legacy');
  assertEquals(await Deno.readTextFile(historicalFile), 'preserve historical bytes');
});

Deno.test('current snapshots reject every historical cleanup slot', () => {
  for (
    const slot of [
      'wholeItemDownloadCleanup',
      'seasonDownloadCleanup',
      'radarrRemovalDownloadCleanup',
    ]
  ) {
    for (
      const cleanup of [{ orphanFiles: [{}], downloadJobs: [] }, {
        orphanFiles: [],
        downloadJobs: [],
        sonarrReclamation: {},
      }]
    ) {
      assertThrows(
        () =>
          validateArrMonitoringEvidence(
            {
              currentLocationPolicyVersion: CURRENT_LOCATION_POLICY_VERSION,
              [slot]: cleanup,
            } as unknown as Parameters<typeof validateArrMonitoringEvidence>[0],
          ),
        Error,
        'historical cleanup',
      );
    }
  }
});

Deno.test('direct restart recovery holds missing policies and only requeues explicit current work', () => {
  withTransaction((client) => {
    for (const [id, policy] of [[11, undefined], [12, CURRENT_LOCATION_POLICY_VERSION]] as const) {
      client.prepare(
        "INSERT INTO deletion_operations (id,client_request_id,request_hash,server_id,library_key,kind,status,target_count,created_at,updated_at) VALUES (?,?,?,1,'movies','movie_version','running',1,1,1)",
      ).run(String(id), String(id), String(id));
      client.prepare(
        "INSERT INTO deletion_targets (id,operation_id,ordinal,target_kind,target_key,title,snapshot,status,phase,attempt_count,created_at,updated_at) VALUES (?,?,0,'movie_version',?,'Fixture',?,'running','validating',3,1,1)",
      ).run(
        id,
        String(id),
        String(id),
        JSON.stringify({
          ratingKey: String(id),
          libraryKey: 'movies',
          currentLocationPolicyVersion: policy,
        }),
      );
    }
    recoverInterruptedDeletionWork(client, 50);
    assertEquals(
      client.prepare(
        'SELECT id,status,attempt_count FROM deletion_targets WHERE id >= 11 ORDER BY id',
      ).values(),
      [[11, 'needs_attention', 3], [12, 'queued', 3]],
    );
    assertEquals(client.prepare("SELECT status FROM deletion_operations WHERE id = '11'").value(), [
      'needs_attention',
    ]);
    assertEquals(client.prepare("SELECT status FROM deletion_operations WHERE id = '12'").value(), [
      'queued',
    ]);
  });
  assertEquals(cancelDeletionOperation('11', 1), true);
});

Deno.test('unknown legacy transition shapes remain held and viewable without rewriting evidence', async () => {
  const { listDeletionOperations } = await import('./service.ts');
  const malformed = [{}, [null]];
  for (let index = 0; index < malformed.length; index++) {
    const id = 30 + index;
    const snapshot = {
      ratingKey: `unknown-${id}`,
      libraryKey: 'movies',
      arrReassignments: malformed[index],
    };
    withTransaction((client) => {
      client.prepare(
        "INSERT INTO deletion_operations (id,client_request_id,request_hash,server_id,library_key,kind,status,target_count,created_at,updated_at) VALUES (?,?,?,1,'movies','movie_version','queued',1,1,1)",
      ).run(String(id), String(id), String(id));
      client.prepare(
        "INSERT INTO deletion_targets (id,operation_id,ordinal,target_kind,target_key,title,snapshot,status,phase,created_at,updated_at) VALUES (?,?,0,'movie_version',?,'Malformed transition',?,'queued','validating',1,1)",
      ).run(id, String(id), String(id), JSON.stringify(snapshot));
    });
    withTransaction((client) => holdLegacyDeletionTargets(client, 100));
    const operation = getDeletionOperation(String(id), 1)!;
    const targets = operation.targets as Array<
      { upgradeHold: boolean; upgradeHoldCancellable: boolean }
    >;
    assertEquals(targets[0].upgradeHold, true);
    assertEquals(targets[0].upgradeHoldCancellable, false);
    assertEquals(cancelDeletionOperation(String(id), 1), false);
    const listed = listDeletionOperations(1, { attention: true, limit: 100, offset: 0 });
    assertEquals(listed.operations.find((entry) => entry.id === String(id))?.retryable, false);
    withTransaction((client) => {
      const raw =
        client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<[string]>(
          id,
        )![0];
      assertEquals(JSON.parse(raw).arrReassignments, malformed[index]);
    });
  }
});
