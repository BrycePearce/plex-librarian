import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseDockerReport } from './dockerStorage.ts';
import {
  DISCOVERY_DIRECTORY,
  DISCOVERY_MAX_BYTES,
  discoverySignature,
  equalSecret,
} from './discoveryTransport.ts';

/** Fixed collector command, no request-supplied command, path, filter or Docker API. */
export function collectHostReport(): Promise<string> {
  return new Promise((resolve, reject) => {
    // GNU timeout owns the process group, so a stuck Docker child cannot outlive
    // its collection budget when the shell is interrupted.
    execFile('/usr/bin/timeout', [
      '--kill-after=1s',
      '24s',
      '/bin/sh',
      new URL('./docker-report.sh', import.meta.url).pathname,
      '--helper-pid',
      String(Deno.pid),
    ], {
      timeout: 28_000,
      maxBuffer: DISCOVERY_MAX_BYTES,
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
      },
    }, (error, stdout) => {
      if (error) {
        reject(new Error('Host collection failed'));
        return;
      }
      try {
        resolve(JSON.stringify(parseDockerReport(stdout)));
      } catch {
        reject(new Error('Host evidence invalid'));
      }
    });
  });
}

export async function startDiscoveryHelper(directory: string, collect = collectHostReport) {
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  let key: string;
  try {
    key = (await Deno.readTextFile(`${directory}/key`)).trim();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    key = randomBytes(32).toString('hex');
    await Deno.writeTextFile(`${directory}/key`, key, { createNew: true, mode: 0o600 });
  }
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid discovery key file');
  const path = `${directory}/discovery.sock`;
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isSocket) throw new Error('Discovery socket path is occupied');
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  let pending: Promise<string> | undefined;
  let clients = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/snapshot') {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization ?? '';
    const nonce = req.headers['x-discovery-nonce'];
    if (
      !equalSecret(auth, `Bearer ${key}`) || typeof nonce !== 'string' ||
      !/^[a-f0-9]{64}$/.test(nonce)
    ) {
      res.writeHead(401).end();
      return;
    }
    if (clients >= 4) {
      res.writeHead(429).end();
      return;
    }
    clients++;
    try {
      pending ??= collect().then((raw) => JSON.stringify(parseDockerReport(raw))).finally(() => {
        pending = undefined;
      });
      const report = await pending;
      if (new TextEncoder().encode(report).length > DISCOVERY_MAX_BYTES) {
        throw new Error('Too large');
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-discovery-signature': discoverySignature(key, nonce, report),
      }).end(report);
    } catch {
      res.writeHead(503).end();
    } finally {
      clients--;
    }
  });
  server.maxConnections = 8;
  server.requestTimeout = 30_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await Deno.chmod(path, 0o600);
  return server;
}

if (import.meta.main) {
  // The collector verifies our host PID and both namespace modes against Docker
  // before returning any evidence. /proc namespace readLink requires unrestricted
  // Deno permissions and comparing self with PID 1 cannot prove host membership.
  if (Deno.build.os !== 'linux') throw new Error('Native Linux host required');
  await startDiscoveryHelper(DISCOVERY_DIRECTORY);
}
