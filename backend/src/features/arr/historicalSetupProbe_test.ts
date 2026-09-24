import { assertEquals } from '@std/assert';
import { probeHistoricalSetup } from './historicalSetupProbe.ts';
import type { HistoricalImport } from '../../integrations/arr/historicalImports.ts';

const record: HistoricalImport = {
  service: 'radarr',
  movieId: 1,
  historyId: 1,
  fileId: 2,
  droppedPath: '/remote/complete/Release/film.mkv',
  importedPath: '/movies/Film/film.mkv',
  date: '',
  downloadId: null,
};
const mapping = { kind: 'download' as const, arrPath: '/remote/complete', localPath: '/downloads' };
const good = { sameFile: () => Promise.resolve(false), inspect: () => Promise.resolve(null) };

Deno.test('setup accepts accessible explicit mappings but not missing samples or name-only matches', async () => {
  assertEquals(await probeHistoricalSetup([record], [mapping], [], good), {
    remoteRoot: '/remote/complete',
    localRoot: '/downloads',
    sample: record.droppedPath,
  });
  assertEquals(await probeHistoricalSetup([record], [], ['/downloads'], good), null);
  assertEquals(
    await probeHistoricalSetup([record], [mapping], [], {
      ...good,
      inspect: () => Promise.resolve({ code: 'sample_absent' as const }),
    }),
    null,
  );
});

Deno.test('setup infers a root only from a unique physical-file witness and checks access', async () => {
  const inspected: string[] = [];
  assertEquals(
    await probeHistoricalSetup([record], [], ['/downloads'], {
      sameFile: (left, right) =>
        Promise.resolve(left === '/downloads/Release/film.mkv' && right === record.importedPath),
      inspect: (_root, path) => {
        inspected.push(path);
        return Promise.resolve(null);
      },
    }),
    { remoteRoot: '/remote/complete', localRoot: '/downloads', sample: record.droppedPath },
  );
  assertEquals(inspected, ['/downloads/Release/film.mkv']);
  assertEquals(
    await probeHistoricalSetup([record], [], ['/downloads', '/cleanup-downloads'], {
      ...good,
      sameFile: () => Promise.resolve(true),
    }),
    null,
  );
});

Deno.test('setup excludes unsafe paths, ambiguous mappings, unreadable files and bounds witnesses', async () => {
  let reads = 0;
  const deps = {
    ...good,
    sameFile: () => {
      reads++;
      return Promise.resolve(false);
    },
  };
  assertEquals(await probeHistoricalSetup(Array(100).fill(record), [], ['/downloads'], deps), null);
  assertEquals(reads, 12); // Four records, three ancestors; never all 100 imports.
  assertEquals(
    await probeHistoricalSetup(
      [{ ...record, droppedPath: '/remote/../film' }],
      [mapping],
      [],
      good,
    ),
    null,
  );
  assertEquals(
    await probeHistoricalSetup([record], [mapping, { ...mapping, localPath: '/other' }], [], good),
    null,
  );
  assertEquals(
    await probeHistoricalSetup([record], [mapping], [], {
      ...good,
      inspect: () => Promise.reject(new Error('denied')),
    }),
    null,
  );
});
