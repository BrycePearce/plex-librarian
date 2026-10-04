import { Database } from '@db/sqlite';
import { assertEquals } from '@std/assert';
import { rollupShowSizes } from './showSizeRollup.ts';

Deno.test('show rollups keep unknown totals and scope season aggregates to server and library', () => {
  const client = new Database(':memory:');
  client.exec(`
    CREATE TABLE items (
      server_id, rating_key, library_key, type, view_count, file_size,
      PRIMARY KEY (server_id, rating_key)
    );
    CREATE TABLE seasons (
      server_id, show_rating_key, library_key, view_count, file_size, updated_at
    );
    INSERT INTO items VALUES
      (1, 'sum', 'tv', 'show', 0, NULL),
      (1, 'unknown', 'tv', 'show', 9, 500),
      (1, 'absent', 'tv', 'show', 7, 600),
      (1, 'retained', 'tv', 'show', 0, 0),
      (1, 'movie', 'tv', 'movie', 8, 800),
      (1, 'other-library', 'other', 'show', 3, 300),
      (2, 'sum', 'tv', 'show', 4, 400);
    INSERT INTO seasons VALUES
      (1, 'sum', 'tv', 2, 1000, 2), (1, 'sum', 'tv', 3, 2000, 2),
      (1, 'sum', 'other', 100, 100000, 2), (2, 'sum', 'tv', 100, 100000, 2),
      (1, 'unknown', 'tv', NULL, NULL, 2), (1, 'unknown', 'tv', NULL, NULL, 2),
      (1, 'retained', 'tv', 1, 100, 1), (1, 'retained', 'tv', 2, 200, 2),
      (1, 'movie', 'tv', 100, 100000, 2),
      (1, 'other-library', 'other', 100, 100000, 2);
    CREATE TABLE writes (rating_key);
    CREATE TRIGGER item_write AFTER UPDATE ON items
      BEGIN INSERT INTO writes VALUES (NEW.rating_key); END;
  `);
  try {
    client.transaction(() => rollupShowSizes(client, 1, 'tv'))();
    assertEquals(client.prepare('SELECT rating_key, view_count, file_size FROM items').values(), [
      ['sum', 5, 3000],
      ['unknown', 9, 500],
      ['absent', 7, 600],
      ['retained', 3, 300],
      ['movie', 8, 800],
      ['other-library', 3, 300],
      ['sum', 4, 400],
    ]);
    assertEquals(client.prepare('SELECT COUNT(*) FROM writes').value(), [2]);
    client.transaction(() => rollupShowSizes(client, 1, 'tv'))();
    assertEquals(client.prepare('SELECT COUNT(*) FROM writes').value(), [2]);
  } finally {
    client.close();
  }
});
