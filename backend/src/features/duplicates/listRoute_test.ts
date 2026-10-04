import { assertEquals, assertExists } from '@std/assert';
import { resolve } from '@std/path';
import { Hono } from 'hono';
import type { Statement } from '@db/sqlite';
import { StatementCache } from '../../db/statementCache.ts';
import type { DuplicateSeasonGroup, DuplicatesResponse } from '@plex-librarian/shared/types.ts';

const directory = await Deno.makeTempDir({ prefix: 'duplicate-list-test-' });
const dbPath = resolve(directory, 'duplicates.db');
Deno.env.set('DB_PATH', dbPath);
Deno.env.delete('PLEX_URL');
Deno.env.delete('PLEX_TOKEN');
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(dbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const { default: route } = await import('./listRoute.ts');
const app = new Hono();
app.route('/duplicates', route);

withTransaction((db) => {
  db.exec(`
    INSERT INTO servers(id,machine_identifier,name,url,access_token,last_connected_at)
      VALUES(1,'active','Active','http://plex','token',1),(2,'foreign','Foreign','http://other','token',1);
    INSERT INTO settings(id,client_id,active_server_id) VALUES(1,'client',1)
      ON CONFLICT(id) DO UPDATE SET active_server_id=1;
    INSERT INTO libraries(server_id,key,title,type,synced_at)
      VALUES(1,'a','TV A','show',1),(1,'b','TV B','show',1),(2,'a','Other TV','show',1);
    INSERT INTO items(server_id,rating_key,library_key,title,type,updated_at)
      VALUES(1,'show-a','a','Show A','show',1),(1,'show-b','b','Show B','show',1),
        (2,'show-a','a','Foreign Show','show',1);
  `);
  const seasonInsert = db.prepare(`INSERT INTO seasons
    (server_id,rating_key,show_rating_key,library_key,season_index,title,leaf_count,updated_at)
    VALUES(1,?,?,?,?,?,?,1)`);
  const versionInsert = db.prepare(`INSERT INTO episode_media_versions
    (server_id,media_id,episode_rating_key,season_rating_key,show_rating_key,library_key,
     episode_title,episode_index,season_index,file_size,updated_at)
    VALUES(1,?,?,?,?,?,?,?,?,?,1)`);
  let mediaId = 1;
  for (let seasonIndex = 1; seasonIndex <= 40; seasonIndex++) {
    const seasonKey = `season-${String(seasonIndex).padStart(2, '0')}`;
    const libraryKey = seasonIndex % 2 === 1 ? 'a' : 'b';
    const showKey = `show-${libraryKey}`;
    const count = seasonIndex === 1 ? 620 : seasonIndex === 2 ? 520 : 4;
    seasonInsert.run(seasonKey, showKey, libraryKey, seasonIndex, 'Season', count);
    for (let episode = 1; episode <= count; episode++) {
      const episodeKey = `${seasonKey}-episode-${String(episode).padStart(4, '0')}`;
      // A repeated episode index exercises the rating-key tie-breaker at the cursor boundary.
      const episodeIndex = seasonIndex === 1 && episode === 501 ? 500 : episode;
      const title = seasonIndex === 1 ? `Needle ${episode}` : `Other ${episode}`;
      for (const size of [100, 200]) {
        versionInsert.run(
          mediaId++,
          episodeKey,
          seasonKey,
          showKey,
          libraryKey,
          title,
          episodeIndex,
          seasonIndex,
          size,
        );
      }
    }
  }
  // Retained singleton projections must never contribute to technical totals or samples.
  versionInsert.run(
    mediaId++,
    'singleton',
    'season-02',
    'show-b',
    'b',
    'Other singleton',
    900,
    2,
    999,
  );
  db.exec(`
    INSERT INTO seasons(server_id,rating_key,show_rating_key,library_key,season_index,title,leaf_count,updated_at)
      VALUES(2,'season-01','show-a','a',1,'Foreign season',1,1);
    INSERT INTO episode_media_versions
      (server_id,media_id,episode_rating_key,season_rating_key,show_rating_key,library_key,
       episode_title,episode_index,season_index,file_size,updated_at)
      VALUES(2,1,'foreign','season-01','show-a','a','Needle foreign',1,1,1000000,1),
            (2,2,'foreign','season-01','show-a','a','Needle foreign',1,1,1000000,1);
    INSERT INTO deletion_operations
      (id,client_request_id,request_hash,server_id,library_key,kind,status,target_count,created_at,updated_at)
      VALUES('owned','owned','hash',1,'a','episode_version','needs_attention',1,1,1);
    INSERT INTO deletion_targets
      (operation_id,ordinal,target_kind,target_key,title,snapshot,status,phase,created_at,updated_at)
      VALUES('owned',0,'episode_version','owned','Owned','{"ratingKey":"season-01-episode-0619"}',
        'needs_attention','plex_reconciliation',1,1);
  `);
});

async function read(query: string): Promise<DuplicatesResponse> {
  const response = await app.request(`/duplicates?type=tv&comparison=unknown&${query}`);
  assertEquals(response.status, 200);
  return await response.json();
}

Deno.test('technical duplicate totals cross key pages and season batches without retaining full seasons', async () => {
  const response = await read('limit=200');
  assertEquals(response.total, 40);
  assertEquals(response.duplicateGroupTotal, 1291);
  const seasons = response.groups as DuplicateSeasonGroup[];
  assertEquals(seasons.reduce((sum, season) => sum + season.combinedFileSize!, 0), 1291 * 300);
  assertEquals(seasons.reduce((sum, season) => sum + season.reclaimableFileSize!, 0), 1291 * 100);
  const first = seasons.find((season) => season.seasonRatingKey === 'season-01');
  assertExists(first);
  assertEquals(first.duplicateGroupCount, 619);
  assertEquals(first.episodes.length, 20);
  assertEquals(
    first.episodes.map((episode) => episode.episodeIndex),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  const second = seasons.find((season) => season.seasonRatingKey === 'season-02');
  assertExists(second);
  assertEquals(second.duplicateGroupCount, 520);
  assertEquals(second.episodes.length, 20);
  assertEquals(seasons.some((season) => season.libraryKey === 'a'), true);
  assertEquals(seasons.some((season) => season.libraryKey === 'b'), true);
  assertEquals(seasons.some((season) => season.showTitle === 'Foreign Show'), false);
  assertEquals(
    seasons.flatMap((season) => season.episodes).some((episode) =>
      episode.episodeRatingKey === 'singleton'
    ),
    false,
  );
  const deep = await read('limit=10&offset=26');
  assertEquals(deep.total, 40);
  assertEquals(deep.duplicateGroupTotal, 1291);
  assertEquals(deep.groups, response.groups.slice(26, 36));
});

Deno.test('technical duplicate search applies throughout a season longer than one key page', async () => {
  const response = await read('limit=200&search=Needle');
  assertEquals(response.total, 1);
  assertEquals(response.duplicateGroupTotal, 619);
  const season = response.groups[0] as DuplicateSeasonGroup;
  assertEquals(season.seasonRatingKey, 'season-01');
  assertEquals(season.combinedFileSize, 619 * 300);
  assertEquals(season.reclaimableFileSize, 619 * 100);
  assertEquals(season.episodes.length, 20);
});

Deno.test('unfiltered season previews batch reads and preserve bounded samples, filters and pagination', async () => {
  const original = StatementCache.prototype.execute;
  const queries: string[] = [];
  StatementCache.prototype.execute = function <T>(
    query: string,
    run: (statement: Statement) => T,
  ): T {
    queries.push(query);
    return original.call(this, query, run) as T;
  };
  try {
    for (
      const query of [
        'limit=200',
        'limit=10&offset=26',
        'limit=200&search=Needle',
        'limit=200&search=Show B',
        'limit=10&offset=100',
      ]
    ) {
      const expected = await read(query);
      queries.length = 0;
      const response = await app.request(`/duplicates?type=tv&${query}`);
      assertEquals(response.status, 200);
      const actual = await response.json() as DuplicatesResponse;
      assertEquals(actual, expected);
      assertEquals(
        queries.filter((sql) => sql.includes('row_number() over')).length,
        Math.ceil(actual.groups.length / 25),
      );
      for (const group of actual.groups as DuplicateSeasonGroup[]) {
        assertEquals(group.episodes.length, Math.min(20, group.duplicateGroupCount));
      }
    }
  } finally {
    StatementCache.prototype.execute = original;
  }
});

Deno.test('technical duplicate samples deduplicate inconsistent episode-index groups', async () => {
  withTransaction((db) => {
    db.exec(`INSERT INTO episode_media_versions
      (server_id,media_id,episode_rating_key,season_rating_key,show_rating_key,library_key,
       episode_title,episode_index,season_index,file_size,updated_at)
      VALUES(1,90001,'season-40-episode-0001','season-40','show-b','b','Other 1',2,40,100,1),
            (1,90002,'season-40-episode-0001','season-40','show-b','b','Other 1',2,40,200,1)`);
  });
  const response = await read('limit=200&search=Other');
  const season = response.groups.find((group) =>
    group.mediaType === 'season' && group.seasonRatingKey === 'season-40'
  ) as DuplicateSeasonGroup | undefined;
  assertExists(season);
  assertEquals(season.duplicateGroupCount, 4);
  assertEquals(season.combinedFileSize, 1500);
  assertEquals(season.reclaimableFileSize, 700);
  assertEquals(season.episodes.length, 4);
  assertEquals(new Set(season.episodes.map((episode) => episode.episodeRatingKey)).size, 4);
});
