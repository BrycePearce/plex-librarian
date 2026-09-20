import { assertEquals, assertRejects } from '@std/assert';
import {
  boundedHistoricalInspection,
  inspectHistoricalAccessSample,
} from './historicalAccessInspection.ts';

Deno.test('a stalled read-only inspection times out and cannot become late success', async () => {
  let finish!: (value: string) => void;
  const work = new Promise<string>((resolve) => {
    finish = resolve;
  });
  await assertRejects(() => boundedHistoricalInspection(work, 1), Error, 'timed out');
  finish('late success');
  assertEquals(await boundedHistoricalInspection(Promise.resolve('current')), 'current');
});

Deno.test('historical access distinguishes missing sample, missing root, denied access and non-file targets', async () => {
  const directory = { isDirectory: true, isFile: false } as Deno.FileInfo;
  const file = { isDirectory: false, isFile: true } as Deno.FileInfo;
  const inspect = (path: string) => Promise.resolve(path === '/downloads' ? directory : file);
  const writable = () => Promise.resolve();
  assertEquals(
    await inspectHistoricalAccessSample('/downloads', '/downloads/season/file', {
      inspect,
      writable,
    }),
    null,
  );
  const missingSample = await inspectHistoricalAccessSample(
    '/downloads',
    '/downloads/season/file',
    {
      inspect: (p) =>
        p === '/downloads'
          ? Promise.resolve(directory)
          : Promise.reject(new Deno.errors.NotFound()),
      writable,
    },
  );
  assertEquals(missingSample?.includes('root is accessible'), true);
  await assertRejects(() =>
    inspectHistoricalAccessSample('/downloads', '/downloads/file', {
      inspect: () => Promise.reject(new Deno.errors.NotFound('missing mount')),
      writable,
    }), Deno.errors.NotFound);
  await assertRejects(() =>
    inspectHistoricalAccessSample('/downloads', '/downloads/file', {
      inspect,
      writable: () => Promise.reject(new Deno.errors.PermissionDenied('read-only or denied')),
    }), Deno.errors.PermissionDenied);
  await assertRejects(
    () =>
      inspectHistoricalAccessSample('/downloads', '/downloads/file', {
        inspect: () => Promise.resolve(directory),
        writable,
      }),
    Error,
    'regular file',
  );
  await assertRejects(
    () =>
      inspectHistoricalAccessSample('/downloads', '/downloads/../data/file', { inspect, writable }),
    Error,
    'safe sample',
  );
});
