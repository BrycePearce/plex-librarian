import { Database } from '@db/sqlite';
import { assertEquals } from '@std/assert';
import { HistoryCounts } from './historyCounts.ts';

Deno.test('history counts include all users across pages without inflating on replay', () => {
  const client = new Database(':memory:');
  client.exec(`
    CREATE TABLE items (server_id, library_key, rating_key, view_count);
    CREATE TABLE seasons (server_id, library_key, show_rating_key, season_index, view_count);
    INSERT INTO items VALUES (1, 'tv', '100', 0), (2, 'tv', '100', 0),
      (1, 'other', '100', 0), (1, 'tv', 'movie', 8);
    INSERT INTO seasons VALUES (1, 'tv', '100', 5, 0), (1, 'tv', '100', 0, 0),
      (2, 'tv', '100', 5, 0), (1, 'other', '100', 5, 0);
  `);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const counts = new HistoryCounts(client);
      try {
        for (const accountID of [1, 2, 3, 3]) {
          counts.addPage([{
            ratingKey: '19960',
            grandparentKey: '/library/metadata/100',
            parentIndex: 5,
            viewedAt: 123,
            accountID,
          }]);
        }
        counts.addPage([
          {
            ratingKey: 'special',
            grandparentKey: '/library/metadata/100',
            parentIndex: 0,
            viewedAt: 124,
          },
          { ratingKey: 'movie', viewedAt: 125 },
        ]);
        if (attempt === 0) {
          assertEquals(client.prepare('SELECT view_count FROM items LIMIT 1').value(), [0]);
        }
        counts.publish(1, 'tv');
      } finally {
        counts.dispose();
      }
      assertEquals(client.prepare('SELECT view_count FROM items').values(), [[5], [0], [0], [8]]);
      assertEquals(client.prepare('SELECT view_count FROM seasons').values(), [[4], [1], [0], [0]]);
    }
    // A failed walk is discarded; a new walk starts empty and independently scoped.
    const failed = new HistoryCounts(client);
    const concurrent = new HistoryCounts(client);
    failed.addPage([{ ratingKey: '100', viewedAt: 126 }]);
    failed.dispose();
    concurrent.publish(2, 'tv');
    concurrent.dispose();
    assertEquals(client.prepare('SELECT view_count FROM items').values(), [[5], [0], [0], [8]]);
    assertEquals(
      client.prepare("SELECT name FROM sqlite_temp_master WHERE type = 'table'").values(),
      [],
    );
  } finally {
    client.close();
  }
});
