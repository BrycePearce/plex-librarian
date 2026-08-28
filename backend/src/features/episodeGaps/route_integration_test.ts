import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';
import type { EpisodeGapsResponse } from '@plex-librarian/shared/types.ts';
import type {
  PlexClient,
  PlexEpisodeMediaVersion,
  PlexLibrary,
} from '../../integrations/plex/index.ts';

const directory = await Deno.makeTempDir();
const dbPath = resolve(directory, 'episode-gaps.db');
Deno.env.set('DB_PATH', dbPath);
Deno.env.delete('PLEX_URL');
Deno.env.delete('PLEX_TOKEN');
const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(dbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');

withTransaction((client) => {
  client.exec(`
    INSERT INTO servers (id, machine_identifier, name, url, access_token, last_connected_at)
      VALUES (1, 'active', 'Active', 'http://plex', 'token', 1),
             (2, 'foreign', 'Foreign', 'http://plex', 'token', 1);
    INSERT INTO settings (id, client_id, active_server_id) VALUES (1, 'client', 1)
      ON CONFLICT(id) DO UPDATE SET active_server_id = 1;
    INSERT INTO libraries (server_id, key, title, type, synced_at, episode_audit_synced_at)
      VALUES (1, 'tv', 'TV Shows', 'show', 100, 100),
             (1, 'anime', 'Anime', 'show', 100, NULL),
             (2, 'tv', 'Foreign TV', 'show', 100, 100);
    INSERT INTO items (server_id, rating_key, library_key, title, type, tvdb_id, updated_at)
      VALUES (1, 'show-a', 'tv', 'Alpha Show', 'show', 123, 100),
             (1, 'show-b', 'tv', 'Broken Show', 'show', NULL, 100),
             (1, 'show-c', 'tv', 'Malformed JSON Show', 'show', NULL, 100),
             (1, 'show-d', 'tv', 'Unknown Status Show', 'show', NULL, 100),
             (2, 'show-a', 'tv', 'Foreign Alpha', 'show', 123, 100);
    INSERT INTO arr_instances
      (id, server_id, type, name, url, api_key, created_at, updated_at)
      VALUES (7, 1, 'sonarr', 'Sonarr', 'http://sonarr:8989', 'secret', 100, 100);
    INSERT INTO arr_library_mappings
      (server_id, library_key, arr_instance_id, add_import_exclusion)
      VALUES (1, 'tv', 7, 1);
    INSERT INTO seasons (server_id, rating_key, show_rating_key, library_key, season_index, title,
      episode_first_index, episode_last_index, episode_present_count, episode_gap_count,
      episode_gap_ranges_json, episode_audit_status, updated_at)
      VALUES (1, 's1', 'show-a', 'tv', 1, 'Season 1', 1, 5, 4, 1, '[{"start":3,"end":3}]', 'gaps', 100),
             (1, 's2', 'show-b', 'tv', 2, 'Season 2', 1, 5, 4, 2, '[{"start":3,"end":3}]', 'gaps', 100),
             (1, 's3', 'show-c', 'tv', 3, 'Season 3', 1, 5, 4, 1, 'broken', 'gaps', 100),
             (2, 's1', 'show-a', 'tv', 1, 'Season 1', 1, 10, 1, 9, '[{"start":2,"end":10}]', 'gaps', 100);
    UPDATE items SET season_first_index = 1, season_last_index = 3,
      season_present_count = 2, season_gap_count = 1,
      season_gap_ranges_json = '[{"start":2,"end":2}]', season_audit_status = 'gaps'
      WHERE rating_key = 'show-a';
    UPDATE items SET season_first_index = 1, season_last_index = 3,
      season_present_count = 2, season_gap_count = 2,
      season_gap_ranges_json = '[{"start":2,"end":2}]', season_audit_status = 'gaps'
      WHERE server_id = 1 AND rating_key = 'show-b';
    UPDATE items SET season_audit_status = 'irregular', season_audit_reason = 'invalid_season_index'
      WHERE server_id = 1 AND rating_key = 'show-c';
    UPDATE items SET season_first_index = 1, season_last_index = 3,
      season_present_count = 2, season_gap_count = 1,
      season_gap_ranges_json = '[{"start":2,"end":2}]', season_audit_status = 'future_status'
      WHERE server_id = 1 AND rating_key = 'show-d';
  `);
});

const { createApp } = await import('../../app.ts');
const app = createApp();
async function request(query = '') {
  const response = await app.request(`/api/tools/episode-gaps${query ? `?${query}` : ''}`);
  assertEquals(response.status, 200);
  return await response.json() as EpisodeGapsResponse;
}

Deno.test('episode gaps API is server scoped, paginated, and classifies malformed projections', async () => {
  const gaps = await request();
  if (gaps.scope !== 'episode') throw new Error('expected episode response');
  assertEquals(gaps.total, 1);
  assertEquals(gaps.rows[0]?.showTitle, 'Alpha Show');
  assertEquals(gaps.summary.gapSeasonCount, 1);
  assertEquals(gaps.summary.missingEpisodeCount, 1);
  assertEquals(gaps.summary.irregularSeasonCount, 2);
  assertEquals(gaps.summary.checkedLibraryCount, 1);

  const irregular = await request('status=irregular&limit=10&offset=0');
  assertEquals(irregular.total, 2);
  assertEquals(irregular.rows.map((row) => row.reason), [
    'invalid_projection',
    'invalid_projection',
  ]);
  assertEquals(irregular.rows.every((row) => row.status === 'irregular'), true);
});

Deno.test('episode gaps API validates query controls and applies library/search summary scope', async () => {
  const scoped = await request('libraryKey=anime&search=nothing');
  if (scoped.scope !== 'episode') throw new Error('expected episode response');
  assertEquals(scoped.summary.gapSeasonCount, 0);
  assertEquals(scoped.summary.checkedLibraryCount, 0);
  assertEquals((await app.request('/api/tools/episode-gaps?limit=0')).status, 400);
  assertEquals((await app.request('/api/tools/episode-gaps?status=nope')).status, 400);
  assertEquals((await app.request('/api/tools/episode-gaps?scope=nope')).status, 400);
  assertEquals(
    (await app.request('/api/tools/episode-gaps?scope=season&sort=seasonIndex')).status,
    400,
  );
});

Deno.test('season gaps API is scoped, searchable, summarized, and projection-safe', async () => {
  const gaps = await request('scope=season');
  assertEquals(gaps.scope, 'season');
  if (gaps.scope !== 'season') throw new Error('expected season response');
  assertEquals(gaps.total, 1);
  assertEquals(gaps.rows[0]?.showTitle, 'Alpha Show');
  assertEquals(gaps.rows[0]?.missingRanges, [{ start: 2, end: 2 }]);
  assertEquals(gaps.summary, {
    gapShowCount: 1,
    missingSeasonCount: 1,
    checkedLibraryCount: 1,
    irregularShowCount: 3,
  });
  const searched = await request('scope=season&search=alpha&sort=title&order=asc&limit=1&offset=0');
  assertEquals(searched.total, 1);
  const irregular = await request('scope=season&status=irregular');
  assertEquals(irregular.total, 3);
  assertEquals(irregular.rows.every((row) => row.status === 'irregular'), true);
  assertEquals(
    irregular.rows.find((row) => row.showRatingKey === 'show-d')?.reason,
    'invalid_projection',
  );
});

Deno.test('episode gaps exclude ignored parent shows from rows and summaries', async () => {
  withTransaction((client) => {
    client.prepare(
      'INSERT INTO ignored_content (server_id, rating_key, created_at) VALUES (1, ?, 100)',
    ).run('show-a');
  });
  try {
    const gaps = await request();
    if (gaps.scope !== 'episode') throw new Error('expected episode response');
    assertEquals(gaps.total, 0);
    assertEquals(gaps.rows, []);
    assertEquals(gaps.summary.gapSeasonCount, 0);
    assertEquals(gaps.summary.missingEpisodeCount, 0);
    const seasonGaps = await request('scope=season');
    assertEquals(seasonGaps.total, 0);
    if (seasonGaps.scope !== 'season') throw new Error('expected season response');
    assertEquals(seasonGaps.summary.gapShowCount, 0);
    assertEquals(seasonGaps.summary.missingSeasonCount, 0);
  } finally {
    withTransaction((client) => {
      client.prepare('DELETE FROM ignored_content WHERE server_id = 1 AND rating_key = ?').run(
        'show-a',
      );
    });
  }
});

Deno.test('episode gap actions redirect only through active Plex and mapped Sonarr identities', async () => {
  const plex = await app.request('/api/tools/episode-gaps/open/plex/show-a');
  assertEquals(plex.status, 302);
  assertEquals(
    plex.headers.get('location'),
    'http://plex/web/index.html#!/server/active/details?key=%2Flibrary%2Fmetadata%2Fshow-a',
  );
  assertEquals(
    (await app.request('/api/tools/episode-gaps/open/plex/missing')).status,
    404,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    assertEquals(String(input), 'http://sonarr:8989/api/v3/series?tvdbId=123');
    return Promise.resolve(Response.json([{
      id: 42,
      title: 'Alpha Show',
      titleSlug: 'alpha-show',
    }]));
  }) as typeof fetch;
  try {
    const sonarr = await app.request('/api/tools/episode-gaps/open/sonarr/7/show-a');
    assertEquals(sonarr.status, 302);
    assertEquals(sonarr.headers.get('location'), 'http://sonarr:8989/series/alpha-show');
    assertEquals(
      (await app.request('/api/tools/episode-gaps/open/sonarr/7/show-b')).status,
      404,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('episode gaps default query index serves server-wide and library-scoped forms', () => {
  withTransaction((client) => {
    for (
      const [libraryClause, indexName] of [
        ['', 'seasons_episode_gaps_idx'],
        ["AND library_key = 'tv'", 'seasons_episode_gaps_library_idx'],
      ] as const
    ) {
      const plan = client.prepare(`
        EXPLAIN QUERY PLAN
        SELECT rating_key FROM seasons
        WHERE server_id = 1 ${libraryClause}
          AND episode_audit_status = 'gaps'
        ORDER BY episode_gap_count DESC LIMIT 50
      `).all() as Array<Record<string, unknown>>;
      assertEquals(
        plan.some((step) => Object.values(step).some((value) => String(value).includes(indexName))),
        true,
      );
    }
  });
});

Deno.test('season gaps default query index serves server-wide and library-scoped forms', () => {
  withTransaction((client) => {
    for (
      const [libraryClause, indexName] of [
        ['', 'items_season_gaps_idx'],
        ["AND library_key = 'tv'", 'items_season_gaps_library_idx'],
      ] as const
    ) {
      const plan = client.prepare(`
        EXPLAIN QUERY PLAN
        SELECT rating_key FROM items
        WHERE server_id = 1 ${libraryClause}
          AND season_audit_status = 'gaps'
        ORDER BY season_gap_count DESC LIMIT 50
      `).all() as Array<Record<string, unknown>>;
      assertEquals(
        plan.some((step) => Object.values(step).some((value) => String(value).includes(indexName))),
        true,
      );
    }
  });
});

Deno.test('episode sync persists bounded audits and preserves them on unusable projection refreshes', async () => {
  withTransaction((client) => {
    client.exec(`
      INSERT INTO libraries (server_id, key, title, type, synced_at, episode_audit_synced_at)
        VALUES (1, 'sync-tv', 'Sync TV', 'show', 200, NULL);
      INSERT INTO items (server_id, rating_key, library_key, title, type, updated_at)
        VALUES (1, 'sync-show', 'sync-tv', 'Sync Show', 'show', 200);
    `);
  });
  const library = { key: 'sync-tv', title: 'Sync TV', type: 'show' } as PlexLibrary;
  const pages = [{
    episodes: [
      episode('s1', 1, 1),
      episode('s1', 1, 2),
      episode('s1', 1, 2),
      episode('s1', 1, 4),
      episode('s1', 1, 5),
      episode('s2', 2, 1),
      episode('s2', 2, null),
      episode('s2', 2, 3),
    ],
    episodeMediaVersions: [],
  }];
  const { syncShowSizes } = await import('../sync/mediaRollups.ts');
  assertEquals(
    await syncShowSizes(episodeClient(pages), library, 200, 1),
    { pruneCompleted: true },
  );

  const stored = withTransaction((client) =>
    client.prepare(`
      SELECT rating_key, episode_first_index, episode_last_index,
             episode_present_count, episode_gap_count, episode_gap_ranges_json,
             episode_audit_status, episode_audit_reason
      FROM seasons WHERE server_id = 1 AND library_key = 'sync-tv'
      ORDER BY rating_key
    `).all()
  );
  assertEquals(stored, [
    {
      rating_key: 's1',
      episode_first_index: 1,
      episode_last_index: 5,
      episode_present_count: 4,
      episode_gap_count: 1,
      episode_gap_ranges_json: '[{"start":3,"end":3}]',
      episode_audit_status: 'gaps',
      episode_audit_reason: null,
    },
    {
      rating_key: 's2',
      episode_first_index: null,
      episode_last_index: null,
      episode_present_count: null,
      episode_gap_count: null,
      episode_gap_ranges_json: null,
      episode_audit_status: 'irregular',
      episode_audit_reason: 'invalid_episode_index',
    },
  ]);
  const storedShowAudit = withTransaction((client) =>
    client.prepare(`
      SELECT season_first_index, season_last_index, season_present_count, season_gap_count,
             season_gap_ranges_json, season_audit_status, season_audit_reason
      FROM items WHERE server_id = 1 AND rating_key = 'sync-show'
    `).get()
  );
  assertEquals(storedShowAudit, {
    season_first_index: 1,
    season_last_index: 2,
    season_present_count: 2,
    season_gap_count: 0,
    season_gap_ranges_json: '[]',
    season_audit_status: 'ok',
    season_audit_reason: null,
  });

  assertEquals(
    await syncShowSizes(
      episodeClient([{ episodes: [], episodeMediaVersions: [] }]),
      library,
      300,
      1,
    ),
    { pruneCompleted: false },
  );
  const preserved = withTransaction((client) =>
    client.prepare(`
      SELECT episode_audit_status, episode_gap_count, updated_at
      FROM seasons WHERE server_id = 1 AND rating_key = 's1'
    `).get()
  );
  assertEquals(preserved, {
    episode_audit_status: 'gaps',
    episode_gap_count: 1,
    updated_at: 200,
  });
});

Deno.test('season sync independently audits shows and clears obsolete show findings', async () => {
  const { syncShowSizes } = await import('../sync/mediaRollups.ts');
  withTransaction((client) => {
    client.exec(`
      INSERT INTO libraries (server_id, key, title, type, synced_at, episode_audit_synced_at)
        VALUES (1, 'season-sync', 'Season Sync', 'show', 400, NULL);
      INSERT INTO items (server_id, rating_key, library_key, title, type, updated_at,
        season_audit_status, season_gap_count)
        VALUES (1, 'gap-show', 'season-sync', 'Gap Show', 'show', 400, 'ok', 0),
               (1, 'special-show', 'season-sync', 'Special Show', 'show', 400, 'gaps', 5);
    `);
  });
  const library = { key: 'season-sync', title: 'Season Sync', type: 'show' } as PlexLibrary;
  await syncShowSizes(
    episodeClient([{
      episodes: [
        episode('gap-s1', 1, 1, 'gap-show'),
        episode('gap-s3', 3, 1, 'gap-show'),
        episode('special-s0', 0, 1, 'special-show'),
      ],
      episodeMediaVersions: [],
    }]),
    library,
    400,
    1,
  );
  const rows = withTransaction((client) =>
    client.prepare(`
    SELECT rating_key, season_gap_count, season_audit_status, season_audit_reason
    FROM items WHERE library_key = 'season-sync' ORDER BY rating_key
  `).all()
  );
  assertEquals(rows, [
    {
      rating_key: 'gap-show',
      season_gap_count: 1,
      season_audit_status: 'gaps',
      season_audit_reason: null,
    },
    {
      rating_key: 'special-show',
      season_gap_count: null,
      season_audit_status: 'excluded',
      season_audit_reason: 'no_numbered_seasons',
    },
  ]);

  withTransaction((client) => {
    client.prepare("UPDATE items SET updated_at = 500 WHERE library_key = 'season-sync'").run();
  });
  await syncShowSizes(
    episodeClient([{
      episodes: [
        episode('gap-s1', 1, 1, 'gap-show'),
        episode('gap-s2', 2, 1, 'gap-show'),
        episode('gap-s3', 3, 1, 'gap-show'),
        episode('special-s0', 0, 1, 'special-show'),
      ],
      episodeMediaVersions: [],
    }]),
    library,
    500,
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(`
        SELECT season_gap_count, season_audit_status FROM items
        WHERE server_id = 1 AND rating_key = 'gap-show'
      `).get()
    ),
    { season_gap_count: 0, season_audit_status: 'ok' },
  );
});

Deno.test('season sync pages current shows while clearing absent projections', async () => {
  const { syncShowSizes } = await import('../sync/mediaRollups.ts');
  withTransaction((client) => {
    client.prepare(`
      INSERT INTO libraries (server_id, key, title, type, synced_at)
      VALUES (1, 'paged-season-sync', 'Paged Season Sync', 'show', 550)
    `).run();
    const insert = client.prepare(`
      INSERT INTO items (
        server_id, rating_key, library_key, title, type, updated_at,
        season_first_index, season_last_index, season_present_count, season_gap_count,
        season_gap_ranges_json, season_audit_status
      ) VALUES (1, ?, 'paged-season-sync', ?, 'show', 550, 1, 3, 2, 1,
        '[{"start":2,"end":2}]', 'gaps')
    `);
    for (let index = 0; index < 501; index++) {
      const ratingKey = `paged-show-${String(index).padStart(4, '0')}`;
      insert.run(ratingKey, `Paged Show ${index}`);
    }
  });
  await syncShowSizes(
    episodeClient([{
      episodes: [episode('paged-season-1', 1, 1, 'paged-show-0500')],
      episodeMediaVersions: [],
    }]),
    { key: 'paged-season-sync', title: 'Paged Season Sync', type: 'show' } as PlexLibrary,
    550,
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(`
        SELECT season_audit_status, count(*) AS count
        FROM items WHERE library_key = 'paged-season-sync'
        GROUP BY season_audit_status ORDER BY season_audit_status
      `).all()
    ),
    [
      { season_audit_status: 'excluded', count: 500 },
      { season_audit_status: 'ok', count: 1 },
    ],
  );
});

Deno.test('season sync marks conflicting identities irregular and preserves protected roots', async () => {
  const { syncShowSizes } = await import('../sync/mediaRollups.ts');
  withTransaction((client) => {
    client.exec(`
      INSERT INTO libraries (server_id, key, title, type, synced_at)
        VALUES (1, 'conflict-sync', 'Conflict Sync', 'show', 600),
               (1, 'protected-sync', 'Protected Sync', 'show', 700);
      INSERT INTO items (server_id, rating_key, library_key, title, type, updated_at,
        season_first_index, season_last_index, season_present_count, season_gap_count,
        season_gap_ranges_json, season_audit_status)
        VALUES (1, 'conflict-a', 'conflict-sync', 'Conflict A', 'show', 600, NULL, NULL, NULL, NULL, NULL, NULL),
               (1, 'conflict-b', 'conflict-sync', 'Conflict B', 'show', 600, NULL, NULL, NULL, NULL, NULL, NULL),
               (1, 'protected-show', 'protected-sync', 'Protected', 'show', 700,
                 1, 3, 2, 1, '[{"start":2,"end":2}]', 'gaps');
    `);
  });
  await syncShowSizes(
    episodeClient([{
      episodes: [
        episode('shared-season', 1, 1, 'conflict-a'),
        episode('shared-season', 2, 1, 'conflict-b'),
      ],
      episodeMediaVersions: [],
    }]),
    { key: 'conflict-sync', title: 'Conflict Sync', type: 'show' } as PlexLibrary,
    600,
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(`
      SELECT rating_key, season_audit_status, season_audit_reason FROM items
      WHERE library_key = 'conflict-sync' ORDER BY rating_key
    `).all()
    ),
    [
      {
        rating_key: 'conflict-a',
        season_audit_status: 'irregular',
        season_audit_reason: 'conflicting_season_identity',
      },
      {
        rating_key: 'conflict-b',
        season_audit_status: 'irregular',
        season_audit_reason: 'conflicting_season_identity',
      },
    ],
  );
  assertEquals(
    await syncShowSizes(
      episodeClient([{
        episodes: [
          episode('protected-s1', 1, 1, 'protected-show'),
          episode('protected-s2', 2, 1, 'protected-show'),
          episode('protected-s3', 3, 1, 'protected-show'),
        ],
        episodeMediaVersions: [],
      }]),
      { key: 'protected-sync', title: 'Protected Sync', type: 'show' } as PlexLibrary,
      700,
      1,
      true,
      [
        'protected-show',
      ],
    ),
    { pruneCompleted: false },
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(`
      SELECT season_gap_count, season_gap_ranges_json, season_audit_status FROM items
      WHERE rating_key = 'protected-show'
    `).get()
    ),
    {
      season_gap_count: 1,
      season_gap_ranges_json: '[{"start":2,"end":2}]',
      season_audit_status: 'gaps',
    },
  );
});

function episode(
  seasonRatingKey: string,
  seasonIndex: number,
  episodeIndex: number | null,
  showRatingKey = 'sync-show',
) {
  return {
    ratingKey: `${seasonRatingKey}-e${episodeIndex ?? 'invalid'}`,
    seasonRatingKey,
    showRatingKey,
    seasonIndex,
    episodeIndex,
    seasonTitle: `Season ${seasonIndex}`,
    fileSize: 100,
    duration: 1_000,
    viewCount: 0,
  };
}

function episodeClient(
  pages: Array<{
    episodes: ReturnType<typeof episode>[];
    episodeMediaVersions: PlexEpisodeMediaVersion[];
  }>,
): PlexClient {
  return {
    async *libraryEpisodes() {
      for (const page of pages) yield page;
    },
  } as unknown as PlexClient;
}
