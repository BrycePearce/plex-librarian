import { Database } from '@db/sqlite';
import { assertEquals, assertThrows } from '@std/assert';
import { replaceArrLibraryMappings, validPathMappings } from './mappings.ts';

Deno.test('mapping replacement rolls back to the previous set when an insert fails', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE arr_library_mappings (
      server_id INTEGER NOT NULL,
      library_key TEXT NOT NULL,
      arr_instance_id INTEGER NOT NULL CHECK (arr_instance_id != 99),
      add_import_exclusion INTEGER NOT NULL,
      PRIMARY KEY (server_id, library_key, arr_instance_id)
    );
    INSERT INTO arr_library_mappings VALUES (1, 'movies', 1, 1);
  `);

  const replace = sqlite.transaction(() =>
    replaceArrLibraryMappings(sqlite, 1, 'movies', [2, 99], false)
  );
  assertThrows(replace);

  assertEquals(
    sqlite.prepare(
      'SELECT arr_instance_id, add_import_exclusion FROM arr_library_mappings',
    ).values(),
    [[1, 1]],
  );
  sqlite.close();
});

Deno.test('Arr path mapping accepts Windows remote roots with POSIX local roots', () => {
  assertEquals(
    validPathMappings([
      { kind: 'library', arrPath: 'D:/Media/Movies/', localPath: '/media/movies/' },
      { kind: 'download', arrPath: '\\\\nas\\downloads\\', localPath: '/downloads/' },
    ]),
    [
      { kind: 'library', arrPath: 'D:\\Media\\Movies', localPath: '/media/movies' },
      { kind: 'download', arrPath: '\\\\nas\\downloads', localPath: '/downloads' },
    ],
  );
});

Deno.test('Arr path mapping preserves an explicit Windows drive root', () => {
  assertEquals(
    validPathMappings([
      { kind: 'library', arrPath: 'D:\\', localPath: '/media' },
      { kind: 'download', arrPath: 'E:/', localPath: '/downloads' },
    ]),
    [
      { kind: 'library', arrPath: 'D:\\', localPath: '/media' },
      { kind: 'download', arrPath: 'E:\\', localPath: '/downloads' },
    ],
  );
});

Deno.test('Arr path mapping still rejects Windows local container paths and traversal', () => {
  assertEquals(
    validPathMappings([
      { kind: 'library', arrPath: 'D:\\Media', localPath: 'D:\\Media' },
      { kind: 'download', arrPath: 'D:\\Downloads', localPath: '/downloads' },
    ]),
    null,
  );
  assertEquals(
    validPathMappings([
      { kind: 'library', arrPath: 'D:\\Media\\..\\Other', localPath: '/media' },
      { kind: 'download', arrPath: 'D:\\Downloads', localPath: '/downloads' },
    ]),
    null,
  );
});

Deno.test('Arr path mapping rejects overlap between library and download roots', () => {
  for (
    const [libraryLocalPath, downloadLocalPath] of [
      ['/media', '/media'],
      ['/media', '/media/downloads'],
      ['/media/library', '/media'],
      ['/media/./library', '/media/library//downloads/'],
    ]
  ) {
    assertEquals(
      validPathMappings([
        { kind: 'library', arrPath: '/arr/media', localPath: libraryLocalPath },
        { kind: 'download', arrPath: '/arr/downloads', localPath: downloadLocalPath },
      ]),
      null,
    );
  }
});

Deno.test('Arr path mapping keeps boundary-distinct local root prefixes', () => {
  assertEquals(
    validPathMappings([
      { kind: 'library', arrPath: '/arr/media', localPath: '/media' },
      { kind: 'download', arrPath: '/arr/downloads', localPath: '/media-old' },
    ]),
    [
      { kind: 'library', arrPath: '/arr/media', localPath: '/media' },
      { kind: 'download', arrPath: '/arr/downloads', localPath: '/media-old' },
    ],
  );
});
