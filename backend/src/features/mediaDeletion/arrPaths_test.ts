import { assertEquals } from '@std/assert';
import { arrDirname, arrPathIsWithin, resolveArrPath } from './arrPaths.ts';

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

Deno.test('Arr path containment and dirname preserve remote path semantics', () => {
  assertEquals(arrPathIsWithin('/movies/Film/Film.mkv', '/movies/Film'), true);
  assertEquals(arrPathIsWithin('/movies/Film Two/Film.mkv', '/movies/Film'), false);
  assertEquals(arrDirname('/movies/Film/Film.mkv'), '/movies/Film');
  assertEquals(arrDirname('D:\\Movies\\Film\\Film.mkv'), 'D:\\Movies\\Film');
});
