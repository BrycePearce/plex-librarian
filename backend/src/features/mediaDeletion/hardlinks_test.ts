import { assertEquals } from '@std/assert';

import { mapArrPath } from './hardlinks.ts';

Deno.test('Windows Arr paths map case-insensitively into POSIX container paths', () => {
  assertEquals(
    mapArrPath('d:\\DOWNLOADS\\Release\\movie.mkv', 'download', [{
      kind: 'download',
      arrPath: 'D:\\Downloads',
      localPath: '/downloads',
    }]),
    {
      path: '/downloads/Release/movie.mkv',
      root: '/downloads',
      arrRoot: {
        path: 'D:\\Downloads',
        comparison: 'd:\\downloads',
        separator: '\\',
      },
    },
  );
});
