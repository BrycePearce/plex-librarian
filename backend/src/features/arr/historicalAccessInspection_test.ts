import { assertEquals, assertRejects } from '@std/assert';
import {
  boundedHistoricalInspection,
  HistoricalAccessError,
  inspectHistoricalAccessSample,
} from './historicalAccessInspection.ts';
Deno.test('read-only diagnostic distinguishes root, sample, denial and unsupported results', async () => {
  const directory = { isDirectory: true, isFile: false } as Deno.FileInfo;
  const file = { isDirectory: false, isFile: true } as Deno.FileInfo;
  const inspect = (p: string) => Promise.resolve(p === '/downloads' ? directory : file);
  const writable = () => Promise.resolve();
  assertEquals(
    await inspectHistoricalAccessSample('/downloads', '/downloads/release/file', {
      inspect,
      writable,
    }),
    null,
  );
  assertEquals(
    await inspectHistoricalAccessSample('/downloads', '/downloads/release/file', {
      inspect: (p) =>
        p === '/downloads'
          ? Promise.resolve(directory)
          : Promise.reject(new Deno.errors.NotFound()),
      writable,
    }),
    { code: 'sample_absent', folder: '/downloads' },
  );
  for (
    const [error, code] of [[new Deno.errors.NotFound(), 'missing_root'], [
      new Deno.errors.PermissionDenied(),
      'access_denied',
    ], [new Error('unknown'), 'unsupported']] as const
  ) {
    const failure = await assertRejects(
      () =>
        inspectHistoricalAccessSample('/downloads', '/downloads/file', {
          inspect: () => Promise.reject(error),
          writable,
        }),
      HistoricalAccessError,
    );
    assertEquals(failure.diagnostic.code, code);
  }
  const parent = await assertRejects(
    () =>
      inspectHistoricalAccessSample('/downloads', '/downloads/release/file', {
        inspect,
        writable: (p) =>
          p === '/downloads'
            ? Promise.resolve()
            : Promise.reject(new HistoricalAccessError({ code: 'read_only', folder: p })),
      }),
    HistoricalAccessError,
  );
  assertEquals(parent.diagnostic, { code: 'read_only', folder: '/downloads/release' });
});
Deno.test('timeout discards late diagnostic success', async () => {
  let finish!: () => void;
  const work = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const failure = await assertRejects(
    () => boundedHistoricalInspection(work, 1),
    HistoricalAccessError,
  );
  assertEquals(failure.diagnostic.code, 'timeout');
  finish();
  assertEquals(await boundedHistoricalInspection(Promise.resolve('current')), 'current');
});
