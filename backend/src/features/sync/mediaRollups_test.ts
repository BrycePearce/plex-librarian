import { assertEquals } from '@std/assert';
import { Database } from '@db/sqlite';
import type { PlexClient, PlexLibrary } from '../../integrations/plex/index.ts';
import { applyArtistSizeBatch, conservativeSeasonAddedAt, syncShowSizes } from './mediaRollups.ts';
import { completeProjectionPrune } from './service.ts';

Deno.test('artist size writes preserve scope and unknown sizes while skipping unchanged totals', () => {
  const client = new Database(':memory:');
  client.exec(`
    CREATE TABLE items(server_id, rating_key, library_key, type, file_size,
      PRIMARY KEY(server_id, rating_key));
    INSERT INTO items VALUES
      (1,'changed','music','artist',10),
      (1,'unknown','music','artist',NULL),
      (1,'unchanged','music','artist',30),
      (1,'unseen','music','artist',NULL),
      (1,'library','other','artist',10),
      (1,'movie','music','movie',10),
      (2,'changed','music','artist',10);
    CREATE TABLE writes(rating_key);
    CREATE TRIGGER item_write AFTER UPDATE ON items
      BEGIN INSERT INTO writes VALUES(NEW.rating_key); END;
  `);
  try {
    const totals: [string, number][] = [
      ['changed', 20],
      ['unknown', 0],
      ['unchanged', 30],
      ['library', 50],
      ['movie', 50],
    ];
    client.transaction(() => applyArtistSizeBatch(client, 1, 'music', totals))();
    client.transaction(() => applyArtistSizeBatch(client, 1, 'music', totals))();
    const rows = client.prepare(
      'SELECT server_id, rating_key, file_size FROM items ORDER BY server_id, rating_key',
    );
    const writes = client.prepare('SELECT rating_key FROM writes ORDER BY rating_key');
    try {
      assertEquals(rows.values(), [
        [1, 'changed', 20],
        [1, 'library', 10],
        [1, 'movie', 10],
        [1, 'unchanged', 30],
        [1, 'unknown', 0],
        [1, 'unseen', null],
        [2, 'changed', 10],
      ]);
      assertEquals(writes.values(), [['changed'], ['unknown']]);
    } finally {
      rows.finalize();
      writes.finalize();
    }
  } finally {
    client.close();
  }
});

Deno.test('empty episode stream explicitly reports show projection prune incomplete', async () => {
  const plex = {
    async *libraryEpisodes() {
      yield { episodes: [], episodeMediaVersions: [] };
    },
  } as unknown as PlexClient;
  const library = {
    key: 'shows',
    title: 'Shows',
    type: 'show',
  } as PlexLibrary;

  assertEquals(await syncShowSizes(plex, library, 100, 1), { pruneCompleted: false });
});

Deno.test('library prune receipts require every projection applicable to that type', () => {
  assertEquals(completeProjectionPrune('movie', true, false), true);
  assertEquals(completeProjectionPrune('movie', false, true), false);
  assertEquals(completeProjectionPrune('show', true, false), false);
  assertEquals(completeProjectionPrune('show', false, true), false);
  assertEquals(completeProjectionPrune('show', true, true), true);
  assertEquals(completeProjectionPrune('artist', true, true), false);
});

Deno.test('season addition age remains unknown when any episode timestamp is unknown', () => {
  assertEquals(conservativeSeasonAddedAt(100, 200), 200);
  assertEquals(conservativeSeasonAddedAt(200, 100), 200);
  assertEquals(conservativeSeasonAddedAt(null, 200), null);
  assertEquals(conservativeSeasonAddedAt(200, null), null);
});
