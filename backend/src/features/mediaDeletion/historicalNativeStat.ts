/** Deno 2.9.5's bigint stat converts already-rounded numbers. Read native decimal
 * metadata through the container's GNU coreutils stat, with no shell or writes. */
export class HistoricalIdentityUnavailable extends Error {
  constructor(readonly details: string) {
    super(
      'Filesystem identity could not be verified. Check the filesystem and container runtime, then refresh the preview. Ordinary service deletion is still available.',
    );
  }
}

export function exactHistoricalId(value: string | number | null, field: 'dev' | 'ino'): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (
    typeof text !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(text) ||
    BigInt(text) > 18446744073709551615n || (field === 'ino' && text === '0')
  ) throw new Error(`Invalid ${field}: ${String(value)}`);
  return text;
}

export function parseHistoricalNativeStat(output: string, object: string) {
  try {
    const [dev, ino, size, mode, mtime, ctime, end, ...extra] = output.split('\n');
    const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{9} \+0000$/;
    if (
      end !== '' || extra.length || !/^[0-9a-f]{4,8}$/.test(mode) ||
      !/^(0|[1-9][0-9]*)$/.test(size) || !Number.isSafeInteger(Number(size)) ||
      !timestamp.test(mtime) || !timestamp.test(ctime)
    ) throw new Error('Unsupported native stat output');
    return {
      dev: exactHistoricalId(dev, 'dev'),
      ino: exactHistoricalId(ino, 'ino'),
      size: Number(size),
      type: parseInt(mode, 16) & 0xf000,
      mtime,
      ctime,
    };
  } catch (error) {
    throw new HistoricalIdentityUnavailable(`${object}: ${String(error)}`);
  }
}

export async function historicalNativeStat(path: string, object: string) {
  try {
    const result = await new Deno.Command('/usr/bin/stat', {
      // No dereference: a final symlink must never acquire its target's identity.
      args: ['--printf=%d\n%i\n%s\n%f\n%y\n%z\n', '--', path],
      env: { LC_ALL: 'C', TZ: 'UTC' },
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      signal: AbortSignal.timeout(3000),
    }).output();
    if (!result.success) throw new Error(`stat exited ${result.code}`);
    return parseHistoricalNativeStat(new TextDecoder().decode(result.stdout), object);
  } catch (error) {
    if (error instanceof HistoricalIdentityUnavailable) throw error;
    throw new HistoricalIdentityUnavailable(`${object} (${path}): ${String(error)}`);
  }
}
