import { assertEquals, assertThrows } from '@std/assert';
import {
  classify,
  type MatchEvidence,
  type MovieEvidence,
  movieEvidence,
  providerIds,
  trustedPath,
} from './model.ts';
const movie: MovieEvidence = {
  id: 1,
  title: 'Example',
  year: 2000,
  slug: 'example',
  tmdb: '10',
  imdb: 'tt10',
  fileId: 7,
  path: '/arr/movie.mkv',
  importedAt: 100,
};
const match: MatchEvidence = {
  ratingKey: '1',
  title: 'Other title',
  tmdb: ['10'],
  imdb: ['tt10'],
  paths: ['/plex/movie.mkv'],
  exact: true,
};
const run = (
  m: Partial<MovieEvidence> = {},
  matches: MatchEvidence[] = [],
  comparable = true,
  complete = true,
  pending = false,
) => classify({ ...movie, ...m }, matches, comparable, complete, pending, 200000);
Deno.test('missing requires complete trusted catalog evidence, never title similarity', () => {
  assertEquals(run()?.type, 'missing');
  assertEquals(run({}, [], false)?.type, 'unable');
  assertEquals(run({}, [], true, false)?.type, 'unable');
  assertEquals(run({ tmdb: null, imdb: null })?.type, 'unable');
  assertEquals(run({}, [{ ...match, exact: false }])?.type, 'version');
});
Deno.test('exact managed path reconciles missing versus conflicting provider IDs', () => {
  assertEquals(run({}, [match]), null);
  const conflict = run({}, [{ ...match, tmdb: ['99'] }]);
  assertEquals(conflict?.type, 'metadata');
  assertEquals(conflict?.reason.includes('Conflicting'), true);
  const missing = run({}, [{ ...match, tmdb: [] }]);
  assertEquals(missing?.type, 'metadata');
  assertEquals(missing?.reason.includes('lacks'), true);
});
Deno.test('missing cannot bypass grace, queue, malformed file or unknown import time', () => {
  assertEquals(run({ importedAt: 190000 })?.type, 'unable');
  assertEquals(run({ importedAt: null })?.type, 'unable');
  assertEquals(run({}, [], true, true, true)?.type, 'unable');
  assertEquals(run({ fileId: null })?.type, 'unable');
  assertEquals(run({}, [match, { ...match, ratingKey: '2' }])?.type, 'unable');
});
Deno.test('paths require explicit unambiguous mapping, retain case and boundary', () => {
  assertEquals(trustedPath('/arr/movie.mkv', []), null);
  assertEquals(
    trustedPath('/arr/movie.mkv', [{ source: '/arr', target: '/local' }]),
    '/local/movie.mkv',
  );
  assertEquals(trustedPath('/arr2/movie.mkv', [{ source: '/arr', target: '/local' }]), null);
  assertEquals(trustedPath('/arr/../movie.mkv', [{ source: '/arr', target: '/local' }]), null);
  assertEquals(
    trustedPath('/arr/movie.mkv', [{ source: '/arr', target: '/local' }, {
      source: '/arr',
      target: '/other',
    }]),
    null,
  );
  assertEquals(trustedPath('/Arr/movie.mkv', [{ source: '/arr', target: '/local' }]), null);
});
Deno.test('modern and legacy IDs, no title-based identities', () => {
  assertEquals(
    providerIds({
      ratingKey: '1',
      title: 'Test',
      type: 'movie',
      Guid: [{ id: 'tmdb://10' }, { id: 'imdb://tt10' }],
      guid: 'com.plexapp.agents.themoviedb://10?lang=en',
    }),
    { tmdb: ['10'], imdb: ['tt10'] },
  );
  assertEquals(
    providerIds({
      ratingKey: '1',
      title: 'Example',
      type: 'movie',
      guid: 'com.plexapp.agents.imdb://tt10?lang=en',
    }),
    { tmdb: [], imdb: ['tt10'] },
  );
});
Deno.test('Radarr evidence excludes monitored-only and mismatched file IDs', () => {
  assertEquals(movieEvidence({ id: 1, title: 'T', hasFile: false, monitored: true }), null);
  assertEquals(
    movieEvidence({
      id: 1,
      title: 'T',
      hasFile: true,
      movieFileId: 2,
      movieFile: { id: 3, path: '/a' },
    })?.fileId,
    null,
  );
  assertThrows(() => movieEvidence({ id: 1, title: 'T' }));
});

Deno.test('case-insensitive comparison requires an explicit trusted mapping flag', () => {
  assertEquals(
    trustedPath('/PLEX/Movie.MKV', [{ source: '/plex', target: '/Store', caseSensitive: false }]),
    '/store/movie.mkv',
  );
  assertEquals(
    trustedPath('/PLEX/Movie.MKV', [{ source: '/plex', target: '/Store', caseSensitive: true }]),
    null,
  );
});

Deno.test('structured diagnoses distinguish missing evidence without inventing a cause', () => {
  assertEquals(run({}, [], false)?.diagnosis, {
    code: 'evidence_incomplete',
    limitations: ['path_comparison_unavailable'],
  });
  assertEquals(run({}, [], true, false)?.diagnosis, {
    code: 'evidence_incomplete',
    limitations: ['plex_paths_incomplete'],
  });
  assertEquals(run({ tmdb: null, imdb: null }, [], false, false)?.diagnosis, {
    code: 'evidence_incomplete',
    limitations: ['path_comparison_unavailable', 'plex_paths_incomplete', 'movie_ids_missing'],
  });
  assertEquals(run()?.diagnosis.code, 'missing_from_plex');
  assertEquals(run({ fileId: null })?.diagnosis.code, 'radarr_file_incomplete');
  assertEquals(
    run({}, Array.from({ length: 31 }, () => match))?.diagnosis.code,
    'too_many_matches',
  );
  assertEquals(run({}, [match, { ...match, ratingKey: '2' }])?.diagnosis.code, 'multiple_matches');
  assertEquals(run({}, [{ ...match, tmdb: ['99'] }])?.diagnosis.code, 'metadata_conflict');
  assertEquals(run({}, [{ ...match, tmdb: [] }])?.diagnosis.code, 'metadata_ids_missing');
  assertEquals(run({}, [{ ...match, exact: false }])?.diagnosis.code, 'copy_unverified');
});
Deno.test('queue and grace diagnoses retain their precedence over unavailable comparison', () => {
  assertEquals(run({ importedAt: null }, [], false, false, true)?.diagnosis.code, 'import_pending');
  assertEquals(run({ importedAt: 190000 }, [], false, false)?.diagnosis.code, 'import_recent');
  assertEquals(run({ importedAt: null }, [], false, false)?.diagnosis.code, 'import_time_unknown');
});
