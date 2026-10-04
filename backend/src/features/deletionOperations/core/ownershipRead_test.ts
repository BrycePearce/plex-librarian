import { type BindValue, Database } from '@db/sqlite';
import { assert, assertEquals } from '@std/assert';
import { type SQL, sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import {
  episodeRootIsWorkflowOwned,
  episodeRootIsWorkflowOwnedForRead,
  movieRootIsWorkflowOwned,
  movieRootIsWorkflowOwnedForRead,
  seasonRootIsWorkflowOwned,
  seasonRootIsWorkflowOwnedForRead,
  showRootIsWorkflowOwned,
  showRootIsWorkflowOwnedForRead,
} from './ownership.ts';

const dialect = new SQLiteSyncDialect();
const candidateLibrary = sql.raw('c.library_key');
const candidateRatingKey = sql.raw('c.rating_key');
const candidateShowKey = sql.raw('c.show_rating_key');
const candidateSeasonKey = sql.raw('c.season_rating_key');

function guards(libraryKey: string | SQL): [SQL, SQL][] {
  return [
    [
      movieRootIsWorkflowOwned(1, libraryKey, candidateRatingKey),
      movieRootIsWorkflowOwnedForRead(1, libraryKey, candidateRatingKey),
    ],
    [
      showRootIsWorkflowOwned(1, libraryKey, candidateShowKey),
      showRootIsWorkflowOwnedForRead(1, libraryKey, candidateShowKey),
    ],
    [
      seasonRootIsWorkflowOwned(1, libraryKey, candidateSeasonKey, candidateShowKey),
      seasonRootIsWorkflowOwnedForRead(1, libraryKey, candidateSeasonKey, candidateShowKey),
    ],
    [
      episodeRootIsWorkflowOwned(
        1,
        libraryKey,
        candidateRatingKey,
        candidateShowKey,
        candidateSeasonKey,
      ),
      episodeRootIsWorkflowOwnedForRead(
        1,
        libraryKey,
        candidateRatingKey,
        candidateShowKey,
        candidateSeasonKey,
      ),
    ],
  ];
}

function fixture(): Database {
  const client = new Database(':memory:');
  client.exec(`
    CREATE TABLE deletion_operations (id TEXT PRIMARY KEY, server_id INTEGER, library_key TEXT);
    CREATE TABLE deletion_targets (
      operation_id TEXT, target_kind TEXT, snapshot TEXT, status TEXT, phase TEXT
    );
    CREATE TABLE candidates (
      library_key TEXT, rating_key TEXT, show_rating_key TEXT, season_rating_key TEXT
    );
    INSERT INTO candidates VALUES
      ('library', '123', '234', '345'), ('library', '123', '123', '123'),
      ('library', '234', '345', '123'), ('library', '345', '234', '234'),
      ('library', NULL, '234', '345'), ('library', '123', NULL, '345'),
      ('library', '123', '234', NULL), ('library', NULL, NULL, NULL),
      ('other', '123', '234', '345'), (NULL, '123', '234', '345');
    INSERT INTO deletion_operations VALUES ('current', 1, 'library'), ('foreign', 2, 'library');
    INSERT INTO deletion_targets VALUES
      ('foreign', 'whole_item', '{"ratingKey":"123","type":"season","showRatingKey":"234"}',
       'needs_attention', 'plex_reconciliation');
  `);
  return client;
}

Deno.test('list ownership guards match execution guards across lifecycle and relocation states', () => {
  const client = fixture();
  const insert = client.prepare('INSERT INTO deletion_targets VALUES (?, ?, ?, ?, ?)');
  const queries = guards(candidateLibrary).map(([original, optimized]) => {
    const query = dialect.sqlToQuery(sql`
      SELECT coalesce(${original}, false), ${optimized} FROM candidates c
    `);
    return { statement: client.prepare(query.sql), params: query.params as BindValue[] };
  });
  try {
    for (
      const status of [
        'queued',
        'running',
        'waiting_retry',
        'needs_attention',
        'completed',
        'completed_with_warning',
        'cancelled',
      ]
    ) {
      for (const phase of ['plex_reconciliation', 'finalizing']) {
        for (const targetKind of ['whole_item', 'movie_version', 'episode_version']) {
          for (
            const relocation of [
              {},
              { relocationGuidance: {} },
              { relocationGuidance: null },
              { relocationSyncBarrier: {} },
              { relocationSyncBarrier: { finishedAt: null } },
              { relocationSyncBarrier: { finishedAt: 123 } },
              { relocationGuidance: {}, relocationSyncBarrier: { finishedAt: 123 } },
            ]
          ) {
            client.exec("DELETE FROM deletion_targets WHERE operation_id = 'current'");
            insert.run(
              'current',
              targetKind,
              JSON.stringify({
                type: 'season',
                ratingKey: '123',
                showRatingKey: '234',
                seasonRatingKey: '345',
                ...relocation,
              }),
              status,
              phase,
            );
            for (const { statement, params } of queries) {
              for (const [expected, actual] of statement.values(...params)) {
                assertEquals(actual, expected, `${status}/${phase}/${targetKind}`);
              }
            }
          }
        }
      }
    }
  } finally {
    for (const { statement } of queries) statement.finalize();
    insert.finalize();
    client.close();
  }
});

Deno.test('list ownership retains SQLite identity affinity and excludes missing snapshot keys', () => {
  const client = fixture();
  const insert = client.prepare('INSERT INTO deletion_targets VALUES (?, ?, ?, ?, ?)');
  try {
    for (const libraryKey of ['library', candidateLibrary]) {
      for (const [original, optimized] of guards(libraryKey)) {
        const query = dialect.sqlToQuery(sql`
          SELECT coalesce(${original}, false), ${optimized} FROM candidates c
        `);
        const statement = client.prepare(query.sql);
        try {
          for (const targetKind of ['whole_item', 'movie_version', 'episode_version']) {
            for (
              const snapshot of [
                { type: 'season', ratingKey: 123, showRatingKey: 234, seasonRatingKey: 345 },
                { type: 'movie', ratingKey: '123', showRatingKey: '234', seasonRatingKey: '345' },
                { type: 'season', ratingKey: null, showRatingKey: null, seasonRatingKey: null },
                {},
              ]
            ) {
              client.exec("DELETE FROM deletion_targets WHERE operation_id = 'current'");
              insert.run('current', targetKind, JSON.stringify(snapshot), 'queued', 'validating');
              for (const [expected, actual] of statement.values(...query.params as BindValue[])) {
                assertEquals(actual, expected, `${targetKind}/${JSON.stringify(snapshot)}`);
              }
            }
          }
        } finally {
          statement.finalize();
        }
      }
    }
  } finally {
    insert.finalize();
    client.close();
  }
});

Deno.test('list ownership plans compute dynamic-library root sets without correlated history scans', () => {
  const client = fixture();
  try {
    for (const [, optimized] of guards(candidateLibrary)) {
      const query = dialect.sqlToQuery(sql`SELECT ${optimized} FROM candidates c`);
      const statement = client.prepare(`EXPLAIN QUERY PLAN ${query.sql}`);
      try {
        const details = statement.values(...query.params as BindValue[]).map((row) =>
          String(row[3])
        );
        assert(details.some((detail) => detail.includes('LIST SUBQUERY')));
        assert(!details.some((detail) => detail.includes('CORRELATED')));
      } finally {
        statement.finalize();
      }
    }
  } finally {
    client.close();
  }
});
