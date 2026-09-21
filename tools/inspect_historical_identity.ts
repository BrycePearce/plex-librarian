// Read-only metadata diagnostics. Pass a download root and one history-linked file.
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

const [root, source] = Deno.args;
if (!root || !source) throw new Error('Usage: inspect_historical_identity.ts ROOT SOURCE');
console.log(Deno.version);
for (const [object, path] of [['root', root], ['parent', dirname(source)], ['source', source]]) {
  try {
    const numeric = await Deno.lstat(path);
    const bigint = await lstat(path, { bigint: true });
    const os = await new Deno.Command('/usr/bin/stat', {
      args: ['--printf=%d %i\n', '--', path],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    console.log(JSON.stringify({
      object,
      path,
      numeric: {
        dev: numeric.dev,
        ino: numeric.ino,
        devSafe: Number.isSafeInteger(numeric.dev),
        inoSafe: Number.isSafeInteger(numeric.ino),
      },
      bigint: { dev: String(bigint.dev), ino: String(bigint.ino) },
      os: new TextDecoder().decode(os.stdout).trim(),
      osError: new TextDecoder().decode(os.stderr).trim(),
    }));
  } catch (error) {
    console.log(object, String(error));
  }
}
