import { assertEquals } from '@std/assert';
import { resolveArrPath } from './arrPaths.ts';

Deno.test('Arr paths translate between a mounted Plex root and a Windows Arr root', () => {
  const mappings = [{
    kind: 'library' as const,
    arrPath: 'D:\\Movies',
    localPath: '/media/movies',
  }];
  assertEquals(
    resolveArrPath('/media/movies/Film/Film.mkv', 'library', mappings),
    'D:\\Movies\\Film\\Film.mkv',
  );
  assertEquals(
    resolveArrPath('d:\\movies\\Film\\Film.mkv', 'library', mappings),
    'D:\\movies\\Film\\Film.mkv',
  );
});

Deno.test('Arr path resolution fails closed for uncovered and ambiguous local roots', () => {
  assertEquals(
    resolveArrPath('/other/Film.mkv', 'library', [{
      kind: 'library',
      arrPath: '/arr/movies',
      localPath: '/media/movies',
    }]),
    null,
  );
  assertEquals(
    resolveArrPath('/media/Film.mkv', 'library', [
      { kind: 'library', arrPath: '/arr-a', localPath: '/media' },
      { kind: 'library', arrPath: '/arr-b', localPath: '/media' },
    ]),
    null,
  );
});
