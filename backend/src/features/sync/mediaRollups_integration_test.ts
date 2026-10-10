import { assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.19';
import type { PlexClient, PlexLibrary } from '../../integrations/plex/index.ts';

Deno.env.set('DB_PATH', ':memory:');
const { withTransaction } = await import('../../db/index.ts');
const { syncArtistSizes } = await import('./mediaRollups.ts');
const library = { key: 'music', title: 'Music', type: 'artist' } as PlexLibrary;

Deno.test('artist rollups publish multiple batches including the final partial batch', async () => {
  withTransaction((client) => {
    client.exec(`CREATE TABLE items(server_id, rating_key, library_key, type, file_size,
      PRIMARY KEY(server_id, rating_key))`);
    const insert = client.prepare("INSERT INTO items VALUES(1,?,'music','artist',NULL)");
    try {
      for (let i = 0; i < 1001; i++) insert.run(String(i));
    } finally {
      insert.finalize();
    }
  });
  const plex = {
    async *libraryTracks() {
      for (let page = 0; page < 2; page++) {
        yield Array.from({ length: 1001 }, (_, i) => ({
          artistRatingKey: String(i),
          fileSize: page + 1,
        }));
      }
    },
  } as unknown as PlexClient;
  try {
    await syncArtistSizes(plex, library, 1);
    withTransaction((client) => {
      const result = client.prepare('SELECT COUNT(*), MIN(file_size), MAX(file_size) FROM items');
      try {
        assertEquals(result.value(), [1001, 3, 3]);
      } finally {
        result.finalize();
      }
    });
    const failed = {
      async *libraryTracks() {
        yield [{ artistRatingKey: '1000', fileSize: 99 }];
        throw new Error('incomplete track stream');
      },
    } as unknown as PlexClient;
    await assertRejects(() => syncArtistSizes(failed, library, 1), Error, 'incomplete');
    withTransaction((client) => {
      const result = client.prepare("SELECT file_size FROM items WHERE rating_key='1000'");
      try {
        assertEquals(result.value(), [3]);
      } finally {
        result.finalize();
      }
    });
  } finally {
    withTransaction((client) => client.exec('DROP TABLE items'));
  }
});
