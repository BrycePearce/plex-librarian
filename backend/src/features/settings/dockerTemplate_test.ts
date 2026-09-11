import { assert, assertEquals } from '@std/assert';

const cli = Deno.build.os === 'windows'
  ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe'
  : '/usr/bin/docker';

Deno.test({
  name:
    'Docker CLI evaluates the actual collector template against a fixture daemon without exposing unrelated fields',
  ignore: !(await Deno.stat(cli).then(() => true).catch(() => false)),
  async fn() {
    const script = await Deno.readTextFile(new URL('./docker-report.sh', import.meta.url));
    const template = /value=\$\(docker inspect --format '(\{"Id":.*?)' "\$id"\)/.exec(script)?.[1];
    assert(template);
    let inspected = false;
    let minimal = false;
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/_ping') return new Response('OK', { headers: { 'API-Version': '1.45' } });
      if (path.endsWith('/containers/abcd/json')) {
        inspected = true;
        if (minimal) {
          return Response.json({
            Id: 'abcd',
            Name: '/empty',
            State: { Running: true },
            Config: {},
            HostConfig: { NetworkMode: 'none' },
            Mounts: null,
            NetworkSettings: { Networks: { bridge: {} }, Ports: null },
          });
        }
        return Response.json({
          Id: 'abcd',
          Name: '/fixture',
          State: { Running: true },
          Config: {
            Env: ['SECRET=must-not-appear'],
            ExposedPorts: { '32400/tcp': {}, '1900/udp': {} },
          },
          HostConfig: {
            NetworkMode: 'bridge',
            Mounts: [{
              Type: 'volume',
              Source: 'media',
              Target: '/archive',
              VolumeOptions: { Subpath: 'Movies' },
            }, {
              Type: 'bind',
              Source: '/srv/nonrecursive',
              Target: '/limited',
              BindOptions: { NonRecursive: true },
            }, {
              Type: 'bind',
              Source: '/srv/ordinary',
              Target: '/ordinary',
              BindOptions: { NonRecursive: false },
            }],
            Tmpfs: { '/data/hidden': 'must-not-appear' },
          },
          Mounts: [{ Type: 'bind', Source: '/mnt/user/media with spaces', Destination: '/data' }],
          NetworkSettings: {
            Networks: { bridge: { IPAddress: '172.18.0.2', GlobalIPv6Address: '', Aliases: null } },
            Ports: { '32400/tcp': [{ HostIp: '0.0.0.0', HostPort: '32401' }], '1900/udp': null },
          },
        });
      }
      return new Response('Unexpected fixture request', { status: 500 });
    });
    const dir = await Deno.makeTempDir({ prefix: 'librarian-docker-cli-' });
    try {
      const run = () =>
        new Deno.Command(cli, {
          args: [
            '--config',
            dir,
            '--host',
            `tcp://127.0.0.1:${server.addr.port}`,
            'inspect',
            '--format',
            template,
            'abcd',
          ],
          clearEnv: true,
          env: Deno.build.os === 'windows'
            ? { SystemRoot: Deno.env.get('SystemRoot') ?? 'C:/Windows' }
            : {},
          stdout: 'piped',
          stderr: 'piped',
        }).output();
      const result = await run();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      assert(inspected);
      const text = new TextDecoder().decode(result.stdout).trim();
      const value = JSON.parse(`${text},"listeningPorts":[]}`);
      assertEquals(value.Networks[0].Aliases, []);
      assertEquals(value.Ports, [{
        containerPort: '32400/tcp',
        hostIp: '0.0.0.0',
        hostPort: '32401',
      }]);
      assertEquals(value.declaredPorts, ['32400/tcp']);
      assertEquals(value.Mounts[0].Source, '/mnt/user/media with spaces');
      assertEquals(value.volumeSubpaths, [{ Destination: '/archive', Subpath: 'Movies' }]);
      assertEquals(value.tmpfsTargets, ['/data/hidden']);
      assertEquals(value.nonRecursiveBindTargets, ['/limited']);
      assert(!text.includes('must-not-appear'));
      minimal = true;
      const empty = await run();
      assertEquals(empty.code, 0, new TextDecoder().decode(empty.stderr));
      const emptyValue = JSON.parse(
        `${new TextDecoder().decode(empty.stdout).trim()},"listeningPorts":[]}`,
      );
      for (
        const key of [
          'Mounts',
          'declaredPorts',
          'Ports',
          'volumeSubpaths',
          'tmpfsTargets',
          'nonRecursiveBindTargets',
        ]
      ) assertEquals(emptyValue[key], []);
      assertEquals(emptyValue.Networks[0], {
        Name: 'bridge',
        IPAddress: '',
        GlobalIPv6Address: '',
        Aliases: [],
      });
    } finally {
      await server.shutdown();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
