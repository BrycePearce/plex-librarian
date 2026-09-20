import { dirname } from 'node:path';
import { access, constants } from 'node:fs/promises';
import { lstatChain } from '../mediaDeletion/pathNamespace.ts';

/** Timeout does not authorize cleanup; a late OS result is discarded. */
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
          () => reject(new Error('Folder access check timed out; access remains unverified')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read-only diagnostics only. This cannot grant unlink authority. */
export async function inspectHistoricalAccessSample(
  root: string,
  sample: string,
  dependencies = {
    inspect: lstatChain,
    writable: (path: string) => access(path, constants.R_OK | constants.W_OK | constants.X_OK),
  },
): Promise<string | null> {
  if (
    !root.startsWith('/') || !sample.startsWith(root + '/') ||
    sample.split('/').some((p) => p === '..' || p === '.')
  ) throw new Error('No safe sample translation');
  const rootInfo = await dependencies.inspect(root);
  if (!rootInfo.isDirectory) throw new Error('Configured download root is not a directory');
  await dependencies.writable(root);
  try {
    const file = await dependencies.inspect(sample);
    if (!file.isFile) throw new Error('Sample is not a regular file');
    await dependencies.writable(dirname(sample));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return `Download root is accessible; this history-linked sample is absent: ${sample}`;
  }
  return null;
}
