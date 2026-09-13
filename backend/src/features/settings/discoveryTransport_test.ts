import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { startDiscoveryHelper } from './discoveryHelper.ts';
import {
  discoverySignature,
  equalSecret,
  readDiscoveryKey,
  readHostSnapshot,
  validateDiscoveryDirectory,
} from './discoveryTransport.ts';
import { dockerSemanticRevision, parseDockerReport } from './dockerStorage.ts';

const report = () => ({
  version: 3,
  daemonId: 'disposable-transport-fixture',
  generatedAt: new Date().toISOString(),
  hostAddresses: ['192.0.2.10'],
  containers: [{
    Id: 'fixture',
    Name: '/fixture',
    State: { Running: true },
    Mounts: [],
    Networks: [],
    Ports: [],
    NetworkMode: 'host',
    listeningPorts: [32400],
    volumeSubpaths: [],
    tmpfsTargets: [],
    nonRecursiveBindTargets: [],
    Env: ['NOT_A_REAL_SECRET=must-not-cross-transport'],
    Labels: { private: 'excluded' },
  }],
});

Deno.test({
  name:
    'Unix transport expires idle clients while allowing collectors longer than the idle timeout',
  ignore: Deno.build.os !== 'linux',
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: 'discovery-timeout-' });
    let calls = 0;
    const server = await startDiscoveryHelper(directory, async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 6_500));
      return JSON.stringify(report());
    });
    const idle = createConnection(`${directory}/discovery.sock`);
    try {
      const expired = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Idle client did not expire')), 12_000);
        idle.on('error', reject);
        idle.on('close', () => {
          clearTimeout(deadline);
          resolve();
        });
      });
      const [snapshot] = await Promise.all([readHostSnapshot(directory), expired]);
      equal(snapshot.report.daemonId, 'disposable-transport-fixture');
      equal(calls, 1);
      ok(idle.destroyed);
    } finally {
      idle.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test('pairing key reads reject oversized and invalid files without returning their content', async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${directory}/key`, 'a'.repeat(64), { mode: 0o600 });
    equal(await readDiscoveryKey(directory), 'a'.repeat(64));
    await Deno.writeTextFile(`${directory}/key`, 'a'.repeat(129));
    await rejects(() => readDiscoveryKey(directory), /private regular file/);
    await Deno.writeTextFile(`${directory}/key`, 'not-a-key');
    await rejects(() => readDiscoveryKey(directory), /Invalid discovery pairing key/);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test({
  name: 'pairing rejects a FIFO without waiting for a writer',
  ignore: Deno.build.os !== 'linux',
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: 'discovery-fifo-' });
    try {
      const fifo = await new Deno.Command('mkfifo', {
        args: ['-m', '600', `${directory}/key`],
      }).output();
      equal(fifo.code, 0, new TextDecoder().decode(fifo.stderr));
      const probePath = `${directory}/probe.ts`;
      const transport = new URL('./discoveryTransport.ts', import.meta.url).href;
      await Deno.writeTextFile(
        probePath,
        `import { rejects } from 'node:assert/strict';
import { readDiscoveryKey } from ${JSON.stringify(transport)};
await rejects(() => readDiscoveryKey(${JSON.stringify(directory)}), /private regular file/);
`,
      );
      // A broken O_NONBLOCK may leave a native open blocked even after a JS
      // Promise timeout. Bound a separate process and kill it before cleanup.
      const probe = await new Deno.Command('timeout', {
        args: [
          '--kill-after=1s',
          '5s',
          Deno.execPath(),
          'run',
          '--no-config',
          '--no-prompt',
          '--allow-read',
          '--allow-sys=uid',
          probePath,
        ],
      }).output();
      equal(
        probe.code,
        0,
        `FIFO probe failed or timed out: ${new TextDecoder().decode(probe.stderr)}`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: 'pairing rejects writable shared directories, readable keys and symlink substitution',
  ignore: Deno.build.os !== 'linux',
  async fn() {
    const directory = await Deno.makeTempDir();
    const alternate = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${alternate}/key`, 'b'.repeat(64), { mode: 0o600 });
      await Deno.chmod(directory, 0o777);
      await rejects(() => validateDiscoveryDirectory(directory), /not writable by others/);
      await Deno.chmod(directory, 0o700);
      await Deno.symlink(`${alternate}/key`, `${directory}/key`);
      await rejects(() => readDiscoveryKey(directory));
      await Deno.remove(`${directory}/key`);
      await Deno.writeTextFile(`${directory}/key`, 'a'.repeat(64), { mode: 0o644 });
      await rejects(() => readDiscoveryKey(directory), /private regular file/);
      await Deno.chmod(`${directory}/key`, 0o600);
      equal(await readDiscoveryKey(directory), 'a'.repeat(64));
      await Deno.symlink(alternate, `${directory}/alias`);
      await rejects(() => readDiscoveryKey(`${directory}/alias`), /Discovery directory/);
    } finally {
      await Deno.remove(directory, { recursive: true });
      await Deno.remove(alternate, { recursive: true });
    }
  },
});
Deno.test('discovery allowlist excludes inspect secrets and semantic revisions ignore collection time/order', () => {
  const raw = report();
  const clean = parseDockerReport(JSON.stringify(raw));
  ok(!JSON.stringify(clean).includes('must-not-cross-transport'));
  ok(!JSON.stringify(clean).includes('Labels'));
  equal(equalSecret('é', 'a'), false);
  equal(
    dockerSemanticRevision(clean),
    dockerSemanticRevision({ ...clean, generatedAt: 'changed' }),
  );
  const changed = structuredClone(clean);
  changed.containers[0].Id = 'replacement';
  ok(dockerSemanticRevision(clean) !== dockerSemanticRevision(changed));
  ok(
    discoverySignature('key', 'nonce-a', 'report') !==
      discoverySignature('key', 'nonce-b', 'report'),
  );
});

Deno.test({
  name:
    'actual Unix socket pairing transport: authentication, bounded evidence, stale evidence and single collector',
  ignore: Deno.build.os !== 'linux',
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: 'discovery-transport-' });
    let calls = 0;
    let payload = JSON.stringify(report());
    const server = await startDiscoveryHelper(directory, async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return payload;
    });
    try {
      const snapshots = await Promise.all([
        readHostSnapshot(directory),
        readHostSnapshot(directory),
      ]);
      equal(calls, 1);
      equal(snapshots[0].report.daemonId, 'disposable-transport-fixture');
      deepEqual(snapshots[0], snapshots[1]);
      ok(!JSON.stringify(snapshots).includes('must-not-cross-transport'));
      equal((await Deno.stat(`${directory}/key`)).mode! & 0o777, 0o600);
      equal((await Deno.stat(`${directory}/discovery.sock`)).mode! & 0o777, 0o600);
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          { socketPath: `${directory}/discovery.sock`, path: '/snapshot' },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode!));
          },
        );
        req.on('error', reject);
        req.end();
      });
      equal(status, 401);
      equal(calls, 1);
      const key = await readDiscoveryKey(directory);
      for (
        const [path, method, headers, expected] of [
          ['/snapshot', 'POST', {}, 404],
          ['/snapshot?command=anything', 'GET', {}, 404],
          ['/snapshot', 'GET', {
            authorization: `Bearer ${'b'.repeat(64)}`,
            'x-discovery-nonce': 'a'.repeat(64),
          }, 401],
          [
            '/snapshot',
            'GET',
            { authorization: `Bearer ${key}`, 'x-discovery-nonce': 'invalid' },
            401,
          ],
          ['/snapshot', 'GET', {
            authorization: `Bearer ${key}`,
            'x-discovery-nonce': 'a'.repeat(64),
            'content-length': '1',
          }, 400],
        ] as const
      ) {
        const result = await new Promise<number>((resolve, reject) => {
          const req = request(
            { socketPath: `${directory}/discovery.sock`, path, method, headers },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode!));
            },
          );
          req.on('error', reject);
          req.end();
        });
        equal(result, expected);
      }
      equal(calls, 1);
      payload = JSON.stringify({
        ...report(),
        generatedAt: new Date(Date.now() - 61_000).toISOString(),
      });
      await rejects(() => readHostSnapshot(directory), /stale/);
      payload = JSON.stringify({
        ...report(),
        generatedAt: new Date(Date.now() + 6_000).toISOString(),
      });
      await rejects(() => readHostSnapshot(directory), /stale/);
      payload = 'x'.repeat(2_000_001);
      await rejects(() => readHostSnapshot(directory), /unavailable/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
      await Deno.remove(directory, { recursive: true });
    }
  },
});
