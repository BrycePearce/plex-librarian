import { deepStrictEqual as equal, ok } from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

Deno.test('fresh Unraid templates share one private transport without granting Librarian Docker access', async () => {
  const app = await Deno.readTextFile(new URL('../../plex-librarian.xml', import.meta.url));
  const helper = await Deno.readTextFile(
    new URL('./plex-librarian-discovery.xml', import.meta.url),
  );
  const params = (xml: string) => /<ExtraParams>([^<]*)<\/ExtraParams>/.exec(xml)![1];
  const mount = '--mount=type=volume,source=plex-librarian-discovery,target=/discovery';
  ok(params(app).split(' ').includes(`${mount},readonly`));
  ok(params(helper).split(' ').includes(mount));
  ok(!app.includes('Target="/var/run/docker.sock"'));
  ok(!params(app).includes('--pid=host'));
  ok(!params(app).includes('--privileged'));
  for (const xml of [app, helper]) {
    // Two mounts at the same target can hide the paired key/socket.
    ok(!xml.includes('Target="/discovery"'));
    ok(xml.includes('<Privileged>false</Privileged>'));
  }
  ok(helper.includes('Target="/var/run/docker.sock" Default="/var/run/docker.sock" Mode="ro"'));
  ok(
    helper.includes('<Repository>ghcr.io/brycepearce/plex-librarian-discovery:latest</Repository>'),
  );
});

const hasCompose = await new Deno.Command('docker', {
  args: ['compose', 'version'],
  stdout: 'null',
  stderr: 'null',
}).output().then((output) => output.success).catch(() => false);

Deno.test({
  name:
    'Docker resolves release packaging with helper-only host access and separate database storage',
  ignore: !hasCompose,
  async fn() {
    // Configuration resolution only: no daemon, image pulls, container creation or volumes.
    const output = await new Deno.Command('docker', {
      args: [
        'compose',
        '-f',
        fileURLToPath(new URL('./compose.release.yaml', import.meta.url)),
        'config',
        '--format',
        'json',
      ],
    }).output();
    ok(output.success, new TextDecoder().decode(output.stderr));
    const config = JSON.parse(new TextDecoder().decode(output.stdout));
    const app = config.services.librarian;
    const helper = config.services['discovery-helper'];
    equal(app.volumes.map((v: { target: string }) => v.target).sort(), ['/data', '/discovery']);
    equal(app.volumes.find((v: { target: string }) => v.target === '/discovery').read_only, true);
    equal(app.volumes.find((v: { target: string }) => v.target === '/data').source, 'database');
    equal(helper.volumes.map((v: { target: string }) => v.target).sort(), [
      '/discovery',
      '/var/run/docker.sock',
    ]);
    const transport = helper.volumes.find((v: { target: string }) => v.target === '/discovery');
    equal(
      transport.source,
      app.volumes.find((v: { target: string }) => v.target === '/discovery').source,
    );
    equal(transport.type, 'volume');
    ok(!transport.read_only);
    equal(helper.network_mode, 'host');
    equal(helper.pid, 'host');
    equal(helper.read_only, true);
    equal(helper.cap_drop, ['ALL']);
    equal(helper.cap_add.sort(), ['DAC_READ_SEARCH', 'SYS_PTRACE']);
    equal(helper.security_opt, ['no-new-privileges:true']);
    equal(helper.cpus, 0.5);
    equal(Number(helper.mem_limit), 128 * 1024 * 1024);
    equal(helper.pids_limit, 64);
    ok(!helper.ports && !helper.privileged);
    ok(!app.privileged && !app.pid && !app.network_mode && !app.cap_add);
    ok(!app.build && !helper.build);
    equal(helper.image, 'ghcr.io/brycepearce/plex-librarian-discovery:latest');
  },
});
