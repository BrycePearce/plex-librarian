import { request } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseDockerReport } from './dockerStorage.ts';

export const DISCOVERY_DIRECTORY = '/discovery';
export const DISCOVERY_MAX_BYTES = 2_000_000;
export const DISCOVERY_TIMEOUT_MS = 30_000;
export const DISCOVERY_MAX_AGE_MS = 60_000;
export const discoveryKeyHash = (key: string) => createHash('sha256').update(key).digest('hex');
export const discoverySignature = (key: string, nonce: string, report: string) =>
  createHmac('sha256', key).update(`${nonce}\n${report}`).digest('hex');
export function equalSecret(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/** The transport directory is a private trust boundary, not a general shared volume. */
export async function validateDiscoveryDirectory(directory: string) {
  const stat = await Deno.lstat(directory);
  if (
    !stat.isDirectory || stat.isSymlink ||
    (Deno.build.os === 'linux' &&
      (stat.uid !== Deno.uid() || ((stat.mode ?? 0) & 0o022) !== 0))
  ) throw new Error('Discovery directory must be owned by this user and not writable by others');
}

export async function readDiscoveryKey(directory: string): Promise<string> {
  await validateDiscoveryDirectory(directory);
  // O_NONBLOCK also prevents an unexpected FIFO from hanging before fstat.
  const file = await open(
    `${directory}/key`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() || stat.size > 128 ||
      (Deno.build.os === 'linux' && (stat.uid !== Deno.uid() || (stat.mode & 0o077) !== 0))
    ) throw new Error('Discovery key must be a private regular file');
    const bytes = new Uint8Array(129);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 128) throw new Error('Invalid discovery pairing key');
    const key = new TextDecoder().decode(bytes.subarray(0, bytesRead)).trim();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid discovery pairing key');
    return key;
  } finally {
    await file.close();
  }
}

/** Local Unix socket only: neither credentials nor evidence traverse LAN HTTP. */
export async function readHostSnapshot(directory = DISCOVERY_DIRECTORY) {
  const key = await readDiscoveryKey(directory);
  const nonce = randomBytes(32).toString('hex');
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({
      socketPath: `${directory}/discovery.sock`,
      path: '/snapshot',
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, 'x-discovery-nonce': nonce },
    }, (res) => {
      let size = 0;
      const chunks: Uint8Array[] = [];
      res.on('data', (chunk: Uint8Array) => {
        size += chunk.byteLength;
        if (size > DISCOVERY_MAX_BYTES + 1024) {
          req.destroy(new Error('Discovery evidence exceeds limit'));
        } else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('Host discovery unavailable'));
          return;
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const report = new TextDecoder().decode(bytes);
        const signature = res.headers['x-discovery-signature'];
        if (
          typeof signature !== 'string' ||
          !equalSecret(signature, discoverySignature(key, nonce, report))
        ) {
          reject(new Error('Host discovery authentication failed'));
          return;
        }
        resolve(report);
      });
    });
    const timer = setTimeout(
      () => req.destroy(new Error('Host discovery timed out')),
      DISCOVERY_TIMEOUT_MS,
    );
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
  const report = parseDockerReport(body);
  const age = Date.now() - Date.parse(report.generatedAt);
  if (age < -5_000 || age > DISCOVERY_MAX_AGE_MS) {
    throw new Error('Host discovery evidence is stale');
  }
  return { report, keyHash: discoveryKeyHash(key) };
}
