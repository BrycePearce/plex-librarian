import { assertEquals, assertThrows } from '@std/assert';
import { ArrClient } from '../../integrations/arr/client.ts';
import { Database } from '@db/sqlite';
import {
  arrDeleteDisposition,
  type ArrDeleteTarget,
  assertArrDeleteIsUnambiguous,
  deleteThroughArr,
  findAmbiguousExternalIds,
} from './delete.ts';

function target(
  instanceName: string,
  fetchImpl: typeof fetch,
): ArrDeleteTarget {
  return {
    instanceId: instanceName.length,
    instanceName,
    client: new ArrClient('radarr', `http://${instanceName}`, 'key', fetchImpl),
    addImportExclusion: true,
  };
}

const movie = {
  title: 'Example',
  type: 'movie',
  tmdbId: 550,
  tvdbId: null,
};

Deno.test('coordinated deletion refuses an external ID shared by Plex items', () => {
  assertThrows(
    () => assertArrDeleteIsUnambiguous(movie, new Set([movie.tmdbId])),
    Error,
    'shares its TMDB ID',
  );
  assertArrDeleteIsUnambiguous(movie, new Set());
});

Deno.test('ambiguity detection spans libraries but remains scoped to one server', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE items (
      server_id INTEGER NOT NULL,
      rating_key TEXT NOT NULL,
      library_key TEXT NOT NULL,
      type TEXT NOT NULL,
      tmdb_id INTEGER,
      tvdb_id INTEGER
    );
    CREATE INDEX items_server_tmdb_id_idx ON items (server_id, tmdb_id)
      WHERE tmdb_id IS NOT NULL;
    INSERT INTO items VALUES
      (1, 'hd', 'movies-hd', 'movie', 550, NULL),
      (1, '4k', 'movies-4k', 'movie', 550, NULL),
      (2, 'other-server', 'movies', 'movie', 999, NULL),
      (1, 'local', 'movies', 'movie', 999, NULL);
  `);
  assertEquals(findAmbiguousExternalIds(sqlite, 1, 'movie', [550, 999]), new Set([550]));
  sqlite.close();
});

Deno.test('coordinated deletion reports every successful and failed Arr mutation', async () => {
  const succeeds = ((input: string | URL | Request) =>
    Promise.resolve(
      String(input).includes('?tmdbId=')
        ? Response.json([{ id: 1, title: 'Example' }])
        : new Response(null, { status: 204 }),
    )) as typeof fetch;
  const failsDelete = ((input: string | URL | Request) =>
    Promise.resolve(
      String(input).includes('?tmdbId=')
        ? Response.json([{ id: 2, title: 'Example' }])
        : new Response('disk error', { status: 500 }),
    )) as typeof fetch;

  const result = await deleteThroughArr(movie, [
    target('primary', succeeds),
    target('backup', failsDelete),
  ]);
  assertEquals(result, {
    deletedInstances: [{ instanceId: 7, instanceName: 'primary', alreadyAbsent: false }],
    failures: [{
      instanceId: 6,
      instanceName: 'backup',
      error: 'Radarr returned 500: disk error',
    }],
  });
  assertEquals(arrDeleteDisposition(result), { status: 'partial', shouldRefreshPlex: true });
  assertEquals(
    arrDeleteDisposition({ deletedInstances: [], failures: result.failures }),
    { status: 'failed', shouldRefreshPlex: false },
  );
});

Deno.test('a retry reconciles a target absent after a durably recorded attempt', async () => {
  const absent = (() => Promise.resolve(Response.json([]))) as typeof fetch;
  assertEquals(
    await deleteThroughArr(movie, [target('primary', absent)], {
      attemptedInstanceIds: new Set([7]),
    }),
    {
      deletedInstances: [{ instanceId: 7, instanceName: 'primary', alreadyAbsent: true }],
      failures: [],
    },
  );
});

Deno.test('a delete 404 is idempotent success after lookup', async () => {
  const disappears = ((input: string | URL | Request) =>
    Promise.resolve(
      String(input).includes('?tmdbId=')
        ? Response.json([{ id: 1, title: 'Example' }])
        : new Response('gone', { status: 404 }),
    )) as typeof fetch;
  assertEquals(await deleteThroughArr(movie, [target('primary', disappears)]), {
    deletedInstances: [{ instanceId: 7, instanceName: 'primary', alreadyAbsent: true }],
    failures: [],
  });
});

Deno.test('the durable attempt callback completes before the destructive request', async () => {
  let attemptRecorded = false;
  const verifiesOrder = ((input: string | URL | Request) => {
    if (String(input).includes('?tmdbId=')) {
      return Promise.resolve(Response.json([{ id: 1, title: 'Example' }]));
    }
    if (!attemptRecorded) throw new Error('delete started before durable marker');
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  await deleteThroughArr(movie, [target('primary', verifiesOrder)], {
    onAttemptStarting: () => {
      attemptRecorded = true;
      return Promise.resolve();
    },
  });
  assertEquals(attemptRecorded, true);
});

Deno.test('coordinated deletion completes every lookup before the first mutation', async () => {
  let deleteRequests = 0;
  const available = ((input: string | URL | Request) => {
    if (String(input).includes('?tmdbId=')) {
      return Promise.resolve(Response.json([{ id: 1, title: 'Example' }]));
    }
    deleteRequests++;
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const unreachable =
    (() => Promise.resolve(new Response('offline', { status: 503 }))) as typeof fetch;

  assertEquals(
    await deleteThroughArr(movie, [target('primary', available), target('offline', unreachable)]),
    {
      deletedInstances: [],
      failures: [{
        instanceId: 7,
        instanceName: 'offline',
        error: 'Radarr returned 503: offline',
      }],
    },
  );
  assertEquals(deleteRequests, 0);
});

Deno.test('retry preserves an already-reconciled target when another lookup fails', async () => {
  const absent = (() => Promise.resolve(Response.json([]))) as typeof fetch;
  const unreachable =
    (() => Promise.resolve(new Response('offline', { status: 503 }))) as typeof fetch;

  const result = await deleteThroughArr(
    movie,
    [target('primary', absent), target('backup', unreachable)],
    { attemptedInstanceIds: new Set([7]) },
  );
  assertEquals(result, {
    deletedInstances: [{ instanceId: 7, instanceName: 'primary', alreadyAbsent: true }],
    failures: [{
      instanceId: 6,
      instanceName: 'backup',
      error: 'Radarr returned 503: offline',
    }],
  });
  assertEquals(arrDeleteDisposition(result), { status: 'partial', shouldRefreshPlex: true });
});
