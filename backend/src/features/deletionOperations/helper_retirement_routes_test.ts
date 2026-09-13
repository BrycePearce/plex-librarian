import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';

const directory = await Deno.makeTempDir({ prefix: 'retired-routes-' });
Deno.env.set('DB_PATH', resolve(directory, 'test.db'));
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(Deno.env.get('DB_PATH')!, resolve(import.meta.dirname!, '../../../drizzle'));
const { createApp } = await import('../../app.ts');
const { withTransaction } = await import('../../db/index.ts');
const { enqueueDeletionOperation, DeletionConflictError } = await import('./service.ts');
const app = createApp();

Deno.test('retired helper and legacy deletion routes reject before reading services or accepting work', async () => {
  const endpoints = [
    ['GET', '/api/settings/service-storage'],
    ['GET', '/api/settings/service-storage/docker-report.sh'],
    ['POST', '/api/settings/service-storage/discovery/enable'],
    ['DELETE', '/api/libraries/1/items'],
    ['DELETE', '/api/duplicates/movies/1/media'],
    ['DELETE', '/api/duplicates/movies/1/media/2'],
    ['DELETE', '/api/duplicates/episodes/1/media/2'],
    ['POST', '/api/libraries/1/items/download-cleanup-preview'],
    ['POST', '/api/libraries/1/seasons/2/deletion-preview'],
    ['POST', '/api/libraries/1/seasons/2/deletion'],
    ['POST', '/api/duplicates/movies/1/media/deletion-preview'],
    ['POST', '/api/duplicates/episodes/1/media/deletion-preview'],
    ['POST', '/api/duplicates/seasons/1/deletion-preview'],
    ['POST', '/api/duplicates/seasons/1/cleanup'],
    ['POST', '/api/deletion-operations/old/resolve'],
    ['POST', '/api/deletion-operations/old/targets/1/accept-removed-unmonitored'],
    ['POST', '/api/deletion-operations/old/targets/1/retry-sonarr-reassignment'],
    ['POST', '/api/deletion-operations/old/targets/1/finish-relocation'],
    ['POST', '/api/deletion-operations/old/targets/1/relocation-sync'],
  ];
  for (const [method, path] of endpoints) {
    const response = await app.request(path, { method });
    assertEquals(response.status, 410, path);
  }
  withTransaction((client) =>
    assertEquals(client.prepare('SELECT COUNT(*) FROM deletion_operations').value(), [0])
  );
  assertEquals((await app.request('/health')).status, 200);
});

Deno.test('internal legacy enqueue rejects before namespace validation or service IO', async () => {
  try {
    await enqueueDeletionOperation(
      {
        serverId: 1,
        libraryKey: '1',
        kind: 'whole_item',
        clientRequestId: 'legacy',
        request: {},
        targets: [{
          targetKind: 'whole_item',
          targetKey: '1',
          title: 'Legacy',
          logicalSize: 1,
          snapshot: {
            ratingKey: '1',
            libraryKey: '1',
            currentLocationPolicyVersion: 2,
            ordinaryPlan: { policyVersion: 2 },
          },
        }],
      } as unknown as Parameters<typeof enqueueDeletionOperation>[0],
    );
    throw new Error('Legacy enqueue unexpectedly succeeded');
  } catch (error) {
    assertEquals(error instanceof DeletionConflictError, true);
    assertEquals((error as Error).message.includes('retired'), true);
  }
});
