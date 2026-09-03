import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { Database } from '@db/sqlite';
import {
  assertAcceptedSonarrInventory,
  assertPersistedSonarrReclamation,
  buildSonarrReclamation,
  canonicalSonarrInventory,
  checkpointHardlinkStorageOutcome,
  deriveHardlinkStorageAggregate,
  type PersistedSonarrReclamation,
  sonarrInventoryIdentity,
  unlinkConfirmedReclamationProofs,
} from './reclamation.ts';

async function accepted(): Promise<PersistedSonarrReclamation> {
  const inventory = [{ id: 10, path: '/tv/Show/one.mkv', size: 1_500 }];
  return {
    instanceId: 1,
    instanceName: 'Sonarr',
    instanceUrl: 'http://sonarr',
    configurationUpdatedAt: 1,
    mappingIdentity: 'mapping',
    seriesId: 7,
    tvdbId: 77,
    inventory,
    inventoryIdentity: await sonarrInventoryIdentity(inventory),
    proofs: [{
      hash: 'a'.repeat(40),
      path: '/downloads/one.mkv',
      importedPath: '/mnt/tv/Show/one.mkv',
      importedRoot: '/mnt/tv',
      root: '/downloads',
      boundary: '/downloads/release',
      remotePath: '/tv/Show/one.mkv',
      size: 1_500,
      method: 'hardlink',
      dev: 1,
      ino: 2,
      nlink: 2,
      rootDevice: '1',
      rootInode: '3',
      importedRootDevice: '1',
      importedRootInode: '4',
      strictTwoLinkProof: true,
      managedFileId: 10,
      managedFileSize: 1_500,
      managedPath: '/tv/Show/one.mkv',
      unlinkConfirmedAt: 5,
    }],
  };
}

Deno.test('verified hardlink aggregation deduplicates bytes and rounds the target once', async () => {
  const value = await accepted();
  value.inventory.push({ id: 11, path: '/tv/Show/two.mkv', size: 1_500 });
  value.proofs.push({
    ...value.proofs[0]!,
    path: '/downloads/alias.mkv',
    managedFileId: 11,
    managedPath: '/tv/Show/two.mkv',
  });
  assertEquals(deriveHardlinkStorageAggregate(value), {
    outcome: 'verified',
    verifiedHardlinkDataSize: 2,
    verifiedFileCount: 1,
    unknownFileCount: 0,
    reasons: [],
  });
});

Deno.test('scoped reclamation accounting excludes out-of-scope Sonarr inventory', async () => {
  const value = await accepted();
  value.inventory.push({ id: 11, path: '/tv/Show/other-season.mkv', size: 9_000 });
  value.accountingManagedFileIds = [10];
  assertPersistedSonarrReclamation(value, value.proofs);
  assertEquals(deriveHardlinkStorageAggregate(value), {
    outcome: 'verified',
    verifiedHardlinkDataSize: 2,
    verifiedFileCount: 1,
    unknownFileCount: 0,
    reasons: [],
  });
  value.accountingManagedFileIds = [11, 10];
  assertThrows(
    () => assertPersistedSonarrReclamation(value, value.proofs),
    Error,
    'reclamation identity is malformed',
  );
});

Deno.test('verified accounting checkpoint is idempotent and independent of logical attribution', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`
      CREATE TABLE deletion_targets (
        id INTEGER PRIMARY KEY, storage_outcome TEXT, verified_hardlink_data_size INTEGER,
        verified_file_count INTEGER, unknown_file_count INTEGER,
        storage_outcome_reasons TEXT, updated_at INTEGER
      );
      CREATE TABLE media_removals (
        server_id INTEGER NOT NULL, operation_id TEXT NOT NULL, target_kind TEXT NOT NULL,
        target_key TEXT NOT NULL, media_size INTEGER, logical_attributable INTEGER NOT NULL,
        verified_hardlink_data_size INTEGER NOT NULL, verified_file_count INTEGER,
        unknown_file_count INTEGER, storage_outcome TEXT, created_at INTEGER NOT NULL,
        UNIQUE(server_id, operation_id, target_kind, target_key)
      );
      INSERT INTO deletion_targets (id, updated_at) VALUES (1, 0);
    `);
    const input = {
      targetId: 1,
      serverId: 2,
      operationId: 'operation',
      targetKey: 'show',
      aggregate: {
        outcome: 'mixed' as const,
        verifiedHardlinkDataSize: 123,
        verifiedFileCount: 1,
        unknownFileCount: 2,
        reasons: ['incomplete_two_link_proof'],
      },
      now: 10,
    };
    checkpointHardlinkStorageOutcome(sqlite, input);
    checkpointHardlinkStorageOutcome(sqlite, input);
    assertEquals(
      sqlite.prepare(
        'SELECT COUNT(*), media_size, logical_attributable, verified_hardlink_data_size, storage_outcome FROM media_removals',
      ).value(),
      [1, null, 0, 123, 'mixed'],
    );
  } finally {
    sqlite.close();
  }
});

Deno.test('verified accounting checkpoint advances into Plex reconciliation atomically', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`
      CREATE TABLE deletion_targets (
        id INTEGER PRIMARY KEY, status TEXT NOT NULL, phase TEXT NOT NULL,
        storage_outcome TEXT, verified_hardlink_data_size INTEGER,
        verified_file_count INTEGER, unknown_file_count INTEGER,
        storage_outcome_reasons TEXT, updated_at INTEGER
      );
      CREATE TABLE media_removals (
        server_id INTEGER NOT NULL, operation_id TEXT NOT NULL, target_kind TEXT NOT NULL,
        target_key TEXT NOT NULL, media_size INTEGER, logical_attributable INTEGER NOT NULL,
        verified_hardlink_data_size INTEGER NOT NULL, verified_file_count INTEGER,
        unknown_file_count INTEGER, storage_outcome TEXT, created_at INTEGER NOT NULL,
        UNIQUE(server_id, operation_id, target_kind, target_key)
      );
      INSERT INTO deletion_targets (id, status, phase, updated_at)
      VALUES (1, 'running', 'arr_coordination', 0);
    `);
    checkpointHardlinkStorageOutcome(sqlite, {
      targetId: 1,
      serverId: 2,
      operationId: 'operation',
      targetKey: 'show',
      aggregate: {
        outcome: 'verified',
        verifiedHardlinkDataSize: 123,
        verifiedFileCount: 1,
        unknownFileCount: 0,
        reasons: [],
      },
      now: 10,
      advanceToPlexReconciliation: true,
    });
    assertEquals(
      sqlite.prepare(
        'SELECT phase, storage_outcome, verified_hardlink_data_size FROM deletion_targets',
      ).value(),
      ['plex_reconciliation', 'verified', 123],
    );
    assertEquals(
      sqlite.prepare(
        'SELECT logical_attributable, verified_hardlink_data_size FROM media_removals',
      ).value(),
      [0, 123],
    );
    assertThrows(
      () =>
        checkpointHardlinkStorageOutcome(sqlite, {
          targetId: 1,
          serverId: 2,
          operationId: 'operation',
          targetKey: 'show',
          aggregate: {
            outcome: 'unknown',
            verifiedHardlinkDataSize: 0,
            verifiedFileCount: 0,
            unknownFileCount: 1,
            reasons: ['later_transient_failure'],
          },
          now: 11,
          advanceToPlexReconciliation: true,
        }),
      Error,
      'deletion target changed',
    );
    assertEquals(
      sqlite.prepare(
        'SELECT phase, storage_outcome, verified_hardlink_data_size FROM deletion_targets',
      ).value(),
      ['plex_reconciliation', 'verified', 123],
    );
  } finally {
    sqlite.close();
  }
});

Deno.test('unconfirmed and invalidated proofs remain unknown', async () => {
  const value = await accepted();
  delete value.proofs[0]!.unlinkConfirmedAt;
  assertEquals(deriveHardlinkStorageAggregate(value).outcome, 'unknown');
  value.proofs[0]!.unlinkConfirmedAt = 5;
  value.proofs[0]!.accountingIneligibleAt = 6;
  assertEquals(deriveHardlinkStorageAggregate(value), {
    outcome: 'unknown',
    verifiedHardlinkDataSize: 0,
    verifiedFileCount: 0,
    unknownFileCount: 1,
    reasons: [],
  });
});

Deno.test('durable Sonarr delete intent is target-local and validated', async () => {
  const value = await accepted();
  assertPersistedSonarrReclamation(value, value.proofs);
  value.arrDeleteAttemptedAt = 10;
  assertPersistedSonarrReclamation(value, value.proofs);
  value.arrDeleteAttemptedAt = 0;
  assertThrows(
    () => assertPersistedSonarrReclamation(value, value.proofs),
    Error,
    'reclamation identity is malformed',
  );
});

Deno.test('accounting-ineligible confirmed proofs retain filesystem postconditions', async () => {
  const value = await accepted();
  value.proofs[0]!.accountingIneligibleAt = 6;
  assertEquals(unlinkConfirmedReclamationProofs(value), value.proofs);
  delete value.proofs[0]!.unlinkConfirmedAt;
  assertEquals(unlinkConfirmedReclamationProofs(value), []);
});

Deno.test('reclamation binds the exact Sonarr path across different path namespaces', async () => {
  const value = await accepted();
  const target = {
    instanceId: value.instanceId,
    instanceName: value.instanceName,
    instanceType: 'sonarr' as const,
    instanceUrl: value.instanceUrl,
    configurationUpdatedAt: value.configurationUpdatedAt,
    mappingIdentity: value.mappingIdentity,
    client: null,
    addImportExclusion: false,
    pathMappings: [],
  } as unknown as Parameters<typeof buildSonarrReclamation>[0];
  const built = buildSonarrReclamation(
    target,
    value.seriesId,
    value.tvdbId,
    value.inventory,
    value.inventoryIdentity,
    value.proofs,
  );
  assertEquals(built.proofs[0]!.managedPath, '/tv/Show/one.mkv');

  assertThrows(
    () =>
      buildSonarrReclamation(
        target,
        value.seriesId,
        value.tvdbId,
        value.inventory,
        value.inventoryIdentity,
        [...value.proofs, { ...value.proofs[0]! }],
      ),
    Error,
    'Conflicting Sonarr EpisodeFile hardlink proof bindings',
  );

  assertThrows(
    () =>
      buildSonarrReclamation(
        target,
        value.seriesId,
        value.tvdbId,
        [...value.inventory, { id: 11, path: '/tv/Show/one.mkv', size: 1_500 }],
        value.inventoryIdentity,
        value.proofs,
      ),
    Error,
    'does not bind to the accepted Sonarr EpisodeFile',
  );
});

Deno.test('accepted complete Sonarr inventory rejects additions or changed files', async () => {
  const value = await accepted();
  const current = {
    episodes: [],
    files: [{
      id: 10,
      seriesId: 7,
      path: '/tv/Show/one.mkv',
      relativePath: 'one.mkv',
      size: 1_500,
      episodeIds: [],
    }],
  };
  assertEquals(canonicalSonarrInventory(current), value.inventory);
  await assertAcceptedSonarrInventory(value, current);
  await assertRejects(
    () =>
      assertAcceptedSonarrInventory(value, {
        ...current,
        files: [...current.files, { ...current.files[0]!, id: 11 }],
      }),
    Error,
    'inventory changed',
  );
});
