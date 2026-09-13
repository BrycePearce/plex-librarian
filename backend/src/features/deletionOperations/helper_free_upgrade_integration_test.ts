import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';

// Start from the discovery-era schema, rather than silently moving the fixture
// baseline when migrations are added. The current journal also ends at 58, so
// today this checks idempotent startup/recovery, not a forward schema migration.
// This verifies preservation and safe legacy holds after helper retirement. It does
// not substitute for native-service acceptance.
const directory = await Deno.makeTempDir({ prefix: 'librarian-upgrade-' });
const dbPath = resolve(directory, 'upgrade.db');
Deno.env.set('DB_PATH', dbPath);
const { runMigrations } = await import('../../db/migrate.ts');
const migrations = resolve(import.meta.dirname!, '../../../drizzle');
const historicalMigrations = resolve(directory, 'historical-migrations');
await Deno.mkdir(resolve(historicalMigrations, 'meta'), { recursive: true });
const journal = JSON.parse(await Deno.readTextFile(resolve(migrations, 'meta/_journal.json')));
const historicalEntries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 58);
await Deno.writeTextFile(
  resolve(historicalMigrations, 'meta/_journal.json'),
  JSON.stringify({ ...journal, entries: historicalEntries }),
);
for (const entry of historicalEntries) {
  await Deno.copyFile(
    resolve(migrations, `${entry.tag}.sql`),
    resolve(historicalMigrations, `${entry.tag}.sql`),
  );
}
await runMigrations(dbPath, historicalMigrations);
const { withTransaction } = await import('../../db/index.ts');
const { recoverInterruptedDeletionWork } = await import('./core/recovery.ts');

Deno.test('helper-free upgrade preserves discovery-era connections, history and accepted legacy work', async () => {
  const preservedTables = [
    'servers',
    'settings',
    'libraries',
    'arr_instances',
    'arr_library_mappings',
    'qbittorrent_instances',
    'arr_path_mappings',
    'qbittorrent_path_mappings',
    'service_path_roots',
    'host_discovery',
    'host_discovery_roots',
    'events',
    'media_removals',
    'media_version_reservations',
  ];
  const before = withTransaction((client) => {
    // Two servers deliberately reuse library keys and service URLs: upgrades must
    // preserve server ownership as well as credential and assignment values.
    for (const id of [1, 2]) {
      client.prepare(
        'INSERT INTO servers (id,machine_identifier,name,url,access_token,last_connected_at) VALUES (?,?,?,?,?,1)',
      ).run(id, `fixture-${id}`, `Server ${id}`, 'http://plex.invalid', `fake-token-${id}`);
      client.prepare(
        "INSERT INTO libraries (server_id,key,title,type,synced_at) VALUES (?,'tv','TV','show',1)",
      ).run(id);
      client.prepare(
        "INSERT INTO arr_instances (id,server_id,type,name,url,api_key,created_at,updated_at) VALUES (?,?,'sonarr','Sonarr','http://sonarr.invalid',?,1,1)",
      ).run(id, id, `fake-key-${id}`);
      client.prepare(
        "INSERT INTO arr_library_mappings (server_id,library_key,arr_instance_id,add_import_exclusion) VALUES (?,'tv',?,0)",
      ).run(id, id);
      client.prepare(
        "INSERT INTO qbittorrent_instances (id,server_id,name,url,username,password,created_at,updated_at) VALUES (?,?,'QB','http://qb.invalid',?,?,1,1)",
      ).run(id, id, `fake-user-${id}`, `fake-password-${id}`);
    }
    client.exec(`
      INSERT INTO settings (id,client_id,active_server_id) VALUES (1,'existing-client',2);
      INSERT INTO arr_path_mappings (arr_instance_id,kind,arr_path,local_path)
        VALUES (1,'root','/shows','/legacy-media/shows');
      INSERT INTO qbittorrent_path_mappings
        (server_id,instance_key,qbittorrent_path,local_path,validation_qbittorrent_path,validation_local_path,validation_size,validated_at,created_at,updated_at)
        VALUES (1,'qb:1','/downloads','/legacy-media/downloads','/downloads/a','/legacy-media/downloads/a',10,1,1,1);
      INSERT INTO service_path_roots (id,server_id,service_key,configuration_identity,service_root,storage_root)
        VALUES (1,1,'sonarr:1','old-identity','/shows','/legacy-media/shows');
      INSERT INTO host_discovery (server_id,pairing_id,daemon_id,key_hash,configuration)
        VALUES (1,'old-pairing','old-daemon','fake-hash','{"preserve":true}');
      INSERT INTO host_discovery_roots (root_id,evidence_identity,checked_at) VALUES (1,'old-evidence',1);
      INSERT INTO events (server_id,type,payload,created_at) VALUES (1,'items.deleted','{"old":true}',1);
      INSERT INTO media_removals (server_id,operation_id,target_kind,target_key,media_size,created_at)
        VALUES (1,'historic','whole_item','old-show',10,1);
    `);
    for (const [ordinal, state] of ['queued', 'running', 'completed'].entries()) {
      const id = ordinal + 1;
      const snapshot = JSON.stringify({
        currentLocationPolicyVersion: 2,
        ratingKey: `show-${id}`,
        libraryKey: 'tv',
        ordinaryPlan: { policyVersion: 2, fingerprint: 'accepted-helper-evidence' },
        ...(state === 'running' ? { plexAttemptedAt: 10 } : {}),
      });
      client.prepare(
        "INSERT INTO deletion_operations (id,client_request_id,request_hash,server_id,library_key,kind,status,target_count,created_at,updated_at) VALUES (?,?,?,1,'tv','whole_item',?,1,1,1)",
      ).run(`op-${id}`, `request-${id}`, `hash-${id}`, state);
      client.prepare(
        "INSERT INTO deletion_targets (id,operation_id,ordinal,target_kind,target_key,title,snapshot,status,phase,plex_attempt_count,created_at,updated_at) VALUES (?,?,0,'whole_item',?,'Old show',?,?,?,?,1,1)",
      ).run(
        id,
        `op-${id}`,
        `show-${id}`,
        snapshot,
        state,
        state === 'queued' ? 'validating' : 'plex_reconciliation',
        state === 'running' ? 1 : 0,
      );
      client.prepare(
        "INSERT INTO media_version_reservations (server_id,media_kind,media_id,rating_key,operation_id,target_id,created_at) VALUES (1,'episode',?,?,?,?,1)",
      ).run(id, `show-${id}`, `op-${id}`, id);
    }
    return Object.fromEntries(
      [...preservedTables, 'deletion_operations', 'deletion_targets'].map((table) => [
        table,
        client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).values(),
      ]),
    );
  });
  await runMigrations(dbPath, migrations);
  await runMigrations(dbPath, migrations);
  withTransaction((client) => {
    const acceptedSnapshots = client.prepare('SELECT snapshot FROM deletion_targets ORDER BY id')
      .values();
    for (const [table, rows] of Object.entries(before)) {
      assertEquals(client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).values(), rows, table);
    }
    recoverInterruptedDeletionWork(client, 50);
    for (const table of preservedTables) {
      if (table === 'events') {
        assertEquals(client.prepare('SELECT * FROM events WHERE id=1').values(), before.events);
        continue;
      }
      assertEquals(client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).values(), before[table]);
    }
    // Legacy work is held for safe cancellation or manual recovery
    // without clearing intent or declaring absence a success.
    assertEquals(
      client.prepare('SELECT id,status,plex_attempt_count FROM deletion_targets ORDER BY id')
        .values(),
      [[1, 'needs_attention', 0], [2, 'needs_attention', 1], [3, 'completed', 0]],
    );
    const after = client.prepare('SELECT snapshot FROM deletion_targets ORDER BY id').values<
      [string]
    >();
    for (const [index, [raw]] of after.entries()) {
      const actual = JSON.parse(raw);
      const expected = JSON.parse(String(acceptedSnapshots[index][0]));
      if (index < 2) {
        assertEquals(actual.upgradeHold, 'current_location_policy_update');
        delete actual.upgradeHold;
      }
      assertEquals(actual, expected);
    }
  });
});
