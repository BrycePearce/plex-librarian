import { assertEquals } from '@std/assert';
import {
  acquireLibraryOperation,
  activeLibraryOperation,
  tryAcquireLibraryOperation,
  withLibraryOperation,
} from './libraryOperations.ts';

Deno.test('library operations reject a competing destructive request', () => {
  const release = tryAcquireLibraryOperation(1, 'movies', 'sync');
  assertEquals(typeof release, 'function');
  assertEquals(activeLibraryOperation(1, 'movies'), 'sync');
  assertEquals(tryAcquireLibraryOperation(1, 'movies', 'deletion'), null);
  release!();
  assertEquals(activeLibraryOperation(1, 'movies'), null);
});

Deno.test('queued library operations run in order and release after errors', async () => {
  const first = await acquireLibraryOperation(2, 'shows', 'sync');
  const events: string[] = [];
  const queued = withLibraryOperation(2, 'shows', 'deletion', () => {
    events.push('deletion');
    throw new Error('expected');
  }).catch(() => events.push('failed'));

  await Promise.resolve();
  assertEquals(events, []);
  first();
  await queued;
  assertEquals(events, ['deletion', 'failed']);
  assertEquals(activeLibraryOperation(2, 'shows'), null);
});

Deno.test('different libraries remain independent', () => {
  const releaseMovies = tryAcquireLibraryOperation(3, 'movies', 'sync');
  const releaseShows = tryAcquireLibraryOperation(3, 'shows', 'deletion');
  assertEquals(typeof releaseMovies, 'function');
  assertEquals(typeof releaseShows, 'function');
  releaseMovies!();
  releaseShows!();
});
