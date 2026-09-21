import { dirname } from 'node:path';
import { lstatChain } from '../mediaDeletion/pathNamespace.ts';
import { historicalMountEntry } from '../mediaDeletion/historicalDownloadIdentity.ts';
import type { HistoricalAccessDiagnostic } from '../../../../shared/historicalDownloads.ts';

export class HistoricalAccessError extends Error {
  constructor(public diagnostic: HistoricalAccessDiagnostic) {
    super(diagnostic.code);
  }
}

/** Late read-only results never replace the timeout result. */
export async function boundedHistoricalInspection<T>(
  work: Promise<T>,
  milliseconds = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new HistoricalAccessError({ code: 'timeout' })),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** GNU coreutils test uses effective OS access (including supplementary groups),
 * unlike Deno 2.9.5's node:fs.access emulation. No shell, writes or permission changes.
 * /usr/bin/test and /proc/self/mountinfo are dependencies of the Linux image. */
export async function checkHistoricalDirectoryAccess(path: string): Promise<void> {
  if (Deno.build.os !== 'linux') {
    throw new HistoricalAccessError({ code: 'unsupported', folder: path });
  }
  try {
    const mount = historicalMountEntry(path, await Deno.readTextFile('/proc/self/mountinfo')).mount;
    const fields = mount.split(' ');
    if (
      fields[5].split(',').includes('ro') ||
      fields[fields.indexOf('-') + 3]?.split(',').includes('ro')
    ) {
      throw new HistoricalAccessError({ code: 'read_only', folder: path });
    }
    for (const flag of ['-r', '-w', '-x']) {
      const result = await new Deno.Command('/usr/bin/test', {
        args: [flag, path],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
        signal: AbortSignal.timeout(3000),
      }).output();
      if (result.code === 1) {
        throw new HistoricalAccessError({ code: 'access_denied', folder: path });
      }
      if (!result.success) throw new HistoricalAccessError({ code: 'unsupported', folder: path });
    }
  } catch (error) {
    if (error instanceof HistoricalAccessError) throw error;
    throw new HistoricalAccessError({
      code: error instanceof DOMException &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'timeout'
        : 'unsupported',
      folder: path,
      details: error instanceof Error ? error.message : 'OS check unavailable',
    });
  }
}

export async function inspectHistoricalAccessSample(
  root: string,
  sample: string,
  dependencies = { inspect: lstatChain, writable: checkHistoricalDirectoryAccess },
): Promise<HistoricalAccessDiagnostic | null> {
  if (
    !root.startsWith('/') || !sample.startsWith(root + '/') ||
    sample.split('/').some((p) => p === '..' || p === '.')
  ) {
    throw new HistoricalAccessError({ code: 'unsupported', folder: root });
  }
  try {
    const info = await dependencies.inspect(root);
    if (!info.isDirectory) {
      throw new HistoricalAccessError({ code: 'invalid_folder', folder: root });
    }
    await dependencies.writable(root);
  } catch (error) {
    throw classifyInspectionError(error, root, 'missing_root');
  }
  try {
    const file = await dependencies.inspect(sample);
    if (!file.isFile) {
      throw new HistoricalAccessError({ code: 'unsupported', folder: dirname(sample) });
    }
    await dependencies.writable(dirname(sample));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { code: 'sample_absent', folder: root };
    throw classifyInspectionError(error, dirname(sample), 'sample_absent');
  }
  return null;
}
function classifyInspectionError(
  error: unknown,
  folder: string,
  missing: HistoricalAccessDiagnostic['code'],
) {
  if (error instanceof HistoricalAccessError) return error;
  return new HistoricalAccessError({
    code: error instanceof Deno.errors.NotFound
      ? missing
      : error instanceof Deno.errors.PermissionDenied
      ? 'access_denied'
      : 'unsupported',
    folder,
  });
}
