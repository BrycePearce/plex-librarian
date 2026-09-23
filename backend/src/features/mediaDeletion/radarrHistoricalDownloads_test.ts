import { assertEquals, assertRejects } from '@std/assert';
import { ArrClient, type RadarrMovieSnapshot } from '../../integrations/arr/client.ts';
import { parseHistoricalImports } from '../../integrations/arr/historicalImports.ts';
import { radarrHistoricalDownloadLineage } from './historicalDownloadLineage.ts';

// Synthetic fixtures use the shape documented by the read-only Radarr research.
// No fixture claims that historical names still contain the original bytes.
const row = () => ({
  id: 11,
  movieId: 7,
  eventType: 'downloadFolderImported',
  date: '2021-09-01T00:00:00Z',
  downloadId: null as string | null,
  data: {
    fileId: '42',
    droppedPath: '/radarr-complete/Release/Film.mkv',
    importedPath: '/movies/Film/Film.mkv',
  },
});
const current: RadarrMovieSnapshot = {
  movieId: 7,
  movieFileId: 42,
  files: [{ id: 42, movieId: 7, path: '/movies/Film/Film.mkv', relativePath: 'Film.mkv', size: 7 }],
};
const lineage = (rows: unknown, snapshot = current, selected = new Set([42])) =>
  radarrHistoricalDownloadLineage(parseHistoricalImports(rows, 7, 'radarr'), snapshot, selected);

Deno.test('Radarr exact current import needs no hash, recorded size or surviving job', () => {
  const result = lineage([row()]);
  assertEquals(result.candidates.length, 1);
  assertEquals(result.candidates[0].owners, [7]);
  assertEquals(result.candidates[0].imports[0].service, 'radarr');
  assertEquals(result.candidates[0].imports[0].episodeId, undefined);
  for (const data of [{ size: 'invalid' }, { size: '12345' }, {}]) {
    assertEquals(lineage([{ ...row(), data: { ...row().data, ...data } }]), result);
  }
});

Deno.test('Radarr excludes old IDs, wrong pointers/owners, moved paths and unselected retained versions', () => {
  for (
    const rows of [
      [{ ...row(), data: { ...row().data, fileId: '41' } }],
      [{ ...row(), movieId: 8 }],
      [{ ...row(), data: { ...row().data, importedPath: '/movies/old.mkv' } }],
      [{ ...row(), data: { ...row().data, droppedPath: undefined } }],
      [{ ...row(), data: { ...row().data, FileId: '41' } }],
      [{ ...row(), data: { ...row().data, DroppedPath: '/other/source' } }],
      [row(), { ...row(), id: 12, movieId: 8 }],
      [row(), { ...row(), id: 12, data: { ...row().data, fileId: '41' } }],
    ]
  ) assertEquals(lineage(rows).candidates.length, 0);
  assertEquals(lineage([row()], { ...current, movieFileId: 41 }).candidates.length, 0);
  assertEquals(
    lineage([row()], { ...current, files: [{ ...current.files[0], movieId: 8 }] }).candidates
      .length,
    0,
  );
  assertEquals(lineage([row()], current, new Set([99])).candidates.length, 0);
});

Deno.test('Radarr unrelated old imports and rename events do not veto valid current source', () => {
  const older = {
    ...row(),
    id: 10,
    data: { ...row().data, fileId: '41', droppedPath: '/radarr-complete/Old/Film.mkv' },
  };
  const result = lineage([older, row(), { id: 12, eventType: 'movieFileRenamed' }]);
  assertEquals(result.candidates.length, 1);
  assertEquals(result.skipped.length, 1);
  assertEquals(
    lineage([{ ...older, data: { ...older.data, fileId: 'bad' } }, row()]).candidates.length,
    1,
  );
});

Deno.test('Radarr bounded native snapshot verifies movie pointer and file resource ownership', async () => {
  const original = globalThis.fetch;
  let movie = { id: 7, movieFileId: 42 };
  let files: unknown[] = current.files;
  const reads: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    reads.push(url.pathname + url.search);
    return Promise.resolve(Response.json(url.pathname.endsWith('/movie/7') ? movie : files));
  }) as typeof fetch;
  try {
    const client = new ArrClient('radarr', 'http://synthetic.invalid', 'fixture');
    assertEquals(await client.radarrMovieSnapshot(7), current);
    assertEquals(reads.length, 2);
    reads.length = 0;
    await client.radarrMovieSnapshot(7, current.files[0]);
    assertEquals(reads, ['/api/v3/movie/7']);
    for (
      const invalid of [[], [...current.files, current.files[0]], [{
        ...current.files[0],
        movieId: 8,
      }]]
    ) {
      files = invalid;
      await assertRejects(() => client.radarrMovieSnapshot(7));
    }
    files = current.files;
    movie = { id: 7, movieFileId: 41 };
    await assertRejects(() => client.radarrMovieSnapshot(7));
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('Radarr history without download ID and uppercase translation witnesses use real client parser', async () => {
  const original = globalThis.fetch;
  const hash = 'a'.repeat(40);
  let reads = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    reads++;
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname.endsWith('/history/movie')) return Promise.resolve(Response.json([row()]));
    assertEquals(url.searchParams.get('downloadId'), hash.toUpperCase());
    return Promise.resolve(
      Response.json({ totalRecords: 1, records: [{ ...row(), downloadId: hash.toUpperCase() }] }),
    );
  }) as typeof fetch;
  try {
    const client = new ArrClient('radarr', 'http://synthetic.invalid', 'fixture');
    assertEquals((await client.historicalImports(7)).records[0].downloadId, null);
    assertEquals((await client.historicalImports(7, [row()])).records.length, 1);
    assertEquals(reads, 1);
    assertEquals((await client.historicalImportsForDownload(hash))[0].movieId, 7);
  } finally {
    globalThis.fetch = original;
  }
});
