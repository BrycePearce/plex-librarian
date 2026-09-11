import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { request } from 'node:http';
import { startDiscoveryHelper } from './discoveryHelper.ts';
import { discoverySignature, equalSecret, readHostSnapshot } from './discoveryTransport.ts';
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
