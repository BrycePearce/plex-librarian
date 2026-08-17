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
  assertEquals(scoped.summary.gapSeasonCount, 0);
  assertEquals(scoped.summary.checkedLibraryCount, 0);
  assertEquals((await app.request('/api/tools/episode-gaps?limit=0')).status, 400);
  assertEquals((await app.request('/api/tools/episode-gaps?status=nope')).status, 400);
});

Deno.test('episode gaps exclude ignored parent shows from rows and summaries', async () => {
  withTransaction((client) => {
    client.prepare(
      'INSERT INTO ignored_content (server_id, rating_key, created_at) VALUES (1, ?, 100)',
    ).run('show-a');
  });
  try {
    const gaps = await request();
    assertEquals(gaps.total, 0);
    assertEquals(gaps.rows, []);
    assertEquals(gaps.summary.gapSeasonCount, 0);
    assertEquals(gaps.summary.missingEpisodeCount, 0);
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

function episode(seasonRatingKey: string, seasonIndex: number, episodeIndex: number | null) {
  return {
    ratingKey: `${seasonRatingKey}-e${episodeIndex ?? 'invalid'}`,
    seasonRatingKey,
    showRatingKey: 'sync-show',
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
