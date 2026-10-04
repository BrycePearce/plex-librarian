import { assertEquals, assertRejects } from '@std/assert';
import { LibraryStatsCache } from './statsCache.ts';

Deno.test('library stats reuse results and isolate server and page keys', async () => {
  let loads = 0;
  const cache = new LibraryStatsCache<number>(() => '0');
  const load = () => Promise.resolve(++loads);
  assertEquals(await cache.get(1, ['movies', 'shows'], load), 1);
  assertEquals(await cache.get(1, ['shows', 'movies'], load), 1);
  assertEquals(await cache.get(2, ['movies', 'shows'], load), 2);
  assertEquals(await cache.get(1, ['movies'], load), 3);
  assertEquals(loads, 3);
});

Deno.test('database revisions invalidate pending and completed library stats', async () => {
  let revision = '0';
  let loads = 0;
  const cache = new LibraryStatsCache<number>(() => revision);
  let resolve!: (value: number) => void;
  const first = cache.get(1, ['movies'], () => {
    loads++;
    return new Promise<number>((done) => resolve = done);
  });
  const concurrent = cache.get(1, ['movies'], () => Promise.resolve(++loads));
  await Promise.resolve();
  revision = '1';
  const newer = cache.get(1, ['movies'], () => Promise.resolve(++loads));
  resolve(1);
  assertEquals(await first, 1);
  assertEquals(await concurrent, 1);
  assertEquals(await newer, 2);
  assertEquals(await cache.get(1, ['movies'], () => Promise.resolve(++loads)), 2);
  revision = '2';
  assertEquals(await cache.get(1, ['movies'], () => Promise.resolve(++loads)), 3);
});

Deno.test('library stats expire, evict old pages, and retry failed reads', async () => {
  let now = 0;
  let loads = 0;
  const cache = new LibraryStatsCache<number>(() => '0', () => now, 2, 100);
  const load = () => Promise.resolve(++loads);
  await cache.get(1, ['a'], load);
  await cache.get(1, ['b'], load);
  assertEquals(await cache.get(1, ['a'], load), 1);
  await cache.get(1, ['c'], load);
  assertEquals(await cache.get(1, ['b'], load), 4);
  now = 100;
  assertEquals(await cache.get(1, ['b'], load), 5);
  await assertRejects(() => cache.get(1, ['failure'], () => Promise.reject(new Error('read'))));
  assertEquals(await cache.get(1, ['failure'], load), 6);
});
