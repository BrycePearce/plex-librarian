/** Offline synthetic fixture generation. No Docker or service API calls. */
type BValue = string | number | Uint8Array | BValue[] | { [key: string]: BValue };
const encoder = new TextEncoder();

function concat(values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

export function bencode(value: BValue): Uint8Array {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Invalid bencode integer');
    return encoder.encode(`i${value}e`);
  }
  if (typeof value === 'string') return bencode(encoder.encode(value));
  if (value instanceof Uint8Array) return concat([encoder.encode(`${value.length}:`), value]);
  if (Array.isArray(value)) {
    return concat([encoder.encode('l'), ...value.map(bencode), encoder.encode('e')]);
  }
  return concat([
    encoder.encode('d'),
    ...Object.keys(value).sort().flatMap((key) => [bencode(key), bencode(value[key])]),
    encoder.encode('e'),
  ]);
}

async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array(bytes)));
}

/** Deliberately bounded tiny generated files, never production/library enumeration. */
export async function makeTorrent(name: string, files: { name: string; bytes: Uint8Array }[]) {
  if (!/^[\w .()-]+$/.test(name) || files.length === 0 || files.length > 8) {
    throw new Error('Invalid fixture name or file count');
  }
  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw new Error('Duplicate fixture filenames');
  }
  if (files.some((file) => !/^[\w .()-]+$/.test(file.name) || file.bytes.length === 0)) {
    throw new Error('Invalid fixture filename or empty file');
  }
  if (files.reduce((sum, file) => sum + file.bytes.length, 0) > 32 * 1024 * 1024) {
    throw new Error('Fixture exceeds 32 MiB bound');
  }
  const content = concat(files.map((file) => file.bytes));
  const pieceLength = 262144;
  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < content.length; offset += pieceLength) {
    pieces.push(await sha1(content.subarray(offset, offset + pieceLength)));
  }
  const info = {
    files: files.map((file) => ({ length: file.bytes.length, path: [file.name] })),
    name,
    'piece length': pieceLength,
    pieces: concat(pieces),
    private: 1,
  };
  const hash = Array.from(await sha1(bencode(info)), (byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  // No tracker, peer, URL or web seed. Add stopped, then recheck in isolated QB.
  return { bytes: bencode({ info }), hash };
}

async function main() {
  if (Deno.args.length) {
    throw new Error('No arguments accepted; output is the ignored fixture tree');
  }
  const output = new URL('./.runtime/generated/', import.meta.url);
  await Deno.mkdir(output); // Refuse an existing run; never overwrite fixture evidence.
  const seed = new URL('synthetic.mkv', output);
  const command = new Deno.Command('ffmpeg', {
    args: [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=44100',
      '-t',
      '60',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '32',
      '-c:a',
      'aac',
      '-b:a',
      '32k',
      decodeURIComponent(seed.pathname).replace(/^\/([A-Za-z]:)/, '$1'),
    ],
    stdout: 'null',
    stderr: 'piped',
  });
  const result = await command.output();
  if (!result.success) throw new Error('Synthetic ffmpeg generation failed; inspect local setup');
  const bytes = await Deno.readFile(seed);
  const manifest: { name: string; hash: string; files: string[]; length: number }[] = [];
  const groups = [1, 2, 3].map((season) => ({
    name: `Doug.S0${season}.720p.WEB-DL.ACCEPTANCE`,
    files: [1, 2].map((episode) => `Doug.S0${season}E0${episode}.720p.WEB-DL.ACCEPTANCE.mkv`),
  }));
  groups.push({
    name: 'The.Matrix.1999.720p.WEB-DL.ACCEPTANCE',
    files: ['The.Matrix.1999.720p.WEB-DL.ACCEPTANCE.mkv'],
  });
  await Deno.mkdir(new URL('payloads/', output));
  await Deno.mkdir(new URL('torrents/', output));
  for (const group of groups) {
    const folder = new URL(`payloads/${group.name}/`, output);
    await Deno.mkdir(folder);
    for (const filename of group.files) {
      await Deno.writeFile(new URL(filename, folder), bytes, { createNew: true });
    }
    const torrent = await makeTorrent(group.name, group.files.map((name) => ({ name, bytes })));
    await Deno.writeFile(new URL(`torrents/${group.name}.torrent`, output), torrent.bytes, {
      createNew: true,
    });
    manifest.push({ ...group, hash: torrent.hash, length: bytes.length });
  }
  await Deno.writeTextFile(
    new URL('manifest.json', output),
    JSON.stringify(manifest, null, 2) + '\n',
    {
      createNew: true,
    },
  );
  console.log(
    'Generated synthetic media and four private trackerless torrents in .runtime/generated.',
  );
  console.log(
    'No service changes performed. Linux hardlink creation/import remains a separate step.',
  );
}

if (import.meta.main) await main();
