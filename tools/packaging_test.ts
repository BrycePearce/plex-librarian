import { deepStrictEqual as equal, ok } from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

Deno.test('Unraid preserves app data, offers optional download access and has no privileged transport', async () => {
  const app = await Deno.readTextFile(new URL('../plex-librarian.xml', import.meta.url));
  equal(/<ExtraParams>([^<]*)<\/ExtraParams>/.exec(app)?.[1], '--init');
  const paths = [...app.matchAll(/<Config\s[\s\S]*?(?:<\/Config>|\/>)/g)]
    .map((match) => match[0]).filter((config) => config.includes('Type="Path"'));
  equal(paths.map((config) => /Target="([^"]+)"/.exec(config)?.[1]), [
    '/data',
    '/cleanup-downloads',
  ]);
  const optional = paths.find((config) => config.includes('Target="/cleanup-downloads"'))!;
  for (const attribute of ['Required="false"', 'Default=""', 'Mode="rw"', 'Display="advanced"']) {
    ok(optional.includes(attribute), `Download access must preserve ${attribute}`);
  }
  ok(!app.includes('/discovery'));
  ok(!app.includes('Target="/var/run/docker.sock"'));
  ok(!app.includes('--pid=host') && !app.includes('--privileged'));
  ok(app.includes('<Privileged>false</Privileged>'));
});

Deno.test('release configuration preserves the existing database identity without the helper', async () => {
  const source = await Deno.readTextFile(new URL('../deploy/compose.yaml', import.meta.url));
  ok(source.includes('name: plex-librarian'));
  ok(source.includes('"database:/data"'));
  ok(!source.includes('discovery') && !source.includes('docker.sock'));
  for (const filename of ['ci.yml', 'docker.yml']) {
    const workflow = await Deno.readTextFile(
      new URL(`../.github/workflows/${filename}`, import.meta.url),
    );
    ok(!workflow.includes('discovery'), `${filename} must not build/publish helper artifacts`);
  }
});

const hasCompose = await new Deno.Command('docker', {
  args: ['compose', 'version'],
  stdout: 'null',
  stderr: 'null',
}).output().then((output) => output.success).catch(() => false);

Deno.test({
  name: 'Docker resolves the single-container release and its unchanged database volume',
  ignore: !hasCompose,
  async fn() {
    // Configuration resolution only; never starts containers or touches a daemon.
    const output = await new Deno.Command('docker', {
      args: [
        'compose',
        '-f',
        fileURLToPath(new URL('../deploy/compose.yaml', import.meta.url)),
        'config',
        '--format',
        'json',
      ],
    }).output();
    ok(output.success, new TextDecoder().decode(output.stderr));
    const config = JSON.parse(new TextDecoder().decode(output.stdout));
    equal(config.name, 'plex-librarian');
    equal(Object.keys(config.services), ['librarian']);
    const app = config.services.librarian;
    equal(app.volumes.map((volume: { target: string }) => volume.target), ['/data']);
    equal(app.volumes[0].source, 'database');
    equal(config.volumes.database.name, 'plex-librarian_database');
    ok(!app.privileged && !app.pid && !app.network_mode && !app.cap_add);
    equal(app.image, 'ghcr.io/brycepearce/plex-librarian:latest');
  },
});
