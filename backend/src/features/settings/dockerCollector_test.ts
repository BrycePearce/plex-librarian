import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { dockerStorage } from './dockerStorage.ts';

Deno.test('Docker host collector uses filtered read-only commands, associates host listeners, and produces an importable report', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'librarian-docker-collector-' });
  const bash = Deno.build.os === 'windows' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
  const unix = (p: string) =>
    p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  try {
    const source = (await Deno.readTextFile(new URL('./docker-report.sh', import.meta.url)))
      .replaceAll('\r\n', '\n');
    const script = join(dir, 'collector.sh');
    await Deno.writeTextFile(script, source);
    const container = {
      Id: 'abcd',
      Name: '/plex',
      State: { Running: true },
      Mounts: [{ Type: 'bind', Source: '/mnt/user/media', Destination: '/data' }],
      NetworkMode: 'host',
      Networks: [],
      Ports: [],
      declaredPorts: [],
      volumeSubpaths: [],
      tmpfsTargets: [],
      nonRecursiveBindTargets: [],
    };
    const json = JSON.stringify(container).slice(0, -1);
    await Deno.writeTextFile(
      join(dir, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  'context show') echo default;;
  'context inspect --format {{.Endpoints.docker.Host}} default') echo unix:///var/run/docker.sock;;
  'context inspect --format {{.Endpoints.docker.Host}} remote') echo tcp://remote:2375;;
  'info --format {{.OSType}}') echo linux;;
  'info --format {{.OperatingSystem}} {{.Name}}') echo "\${FIXTURE_DAEMON:-Unraid server}";;
  'info --format {{json .ID}}') echo '\"fixture-daemon\"';;
  'ps -q --no-trunc') echo abcd;;
  'top abcd -eo pid') printf 'PID\\n42\\n';;
  'inspect --format {{.State.Pid}} {{.HostConfig.PidMode}} {{.HostConfig.NetworkMode}} abcd') echo '42 host host';;
  'inspect --format {{.HostConfig.NetworkMode}} abcd') echo host;;
  *'{{range .Mounts}}'*) : ;;
  'inspect --format '* ) printf '%s\\n' '${json}';;
  *) echo 'Unexpected Docker command' >&2; exit 1;;
esac
`,
    );
    await Deno.writeTextFile(join(dir, 'hostname'), '#!/bin/sh\necho 192.168.1.10\n');
    await Deno.writeTextFile(
      join(dir, 'uname'),
      '#!/bin/sh\nif [ "$1" = -s ]; then echo "${FIXTURE_OS:-Linux}"; else echo "${FIXTURE_KERNEL:-6.12}"; fi\n',
    );
    await Deno.writeTextFile(
      join(dir, 'ss'),
      '#!/bin/sh\nprintf \'LISTEN 0 100 0.0.0.0:32400 *:* users:(("Plex",pid=42,fd=1))\\nLISTEN 0 100 127.0.0.1:9999 *:* users:(("Plex",pid=42,fd=2))\\nLISTEN 0 100 0.0.0.0:8080 *:* users:(("other",pid=55,fd=1))\\n\'\n',
    );
    if (Deno.build.os !== 'windows') {
      for (const name of ['docker', 'hostname', 'ss', 'uname']) {
        await Deno.chmod(join(dir, name), 0o700);
      }
    }
    const calls = join(dir, 'calls');
    const run = async (
      remote = false,
      contextOverride = false,
      fixtureEnv: Record<string, string> = {},
      helperPid?: number,
    ) =>
      await new Deno.Command(bash, {
        args: [
          '-c',
          `export PATH="${unix(dir)}:$PATH"; unset DOCKER_HOST DOCKER_CONTEXT; ${
            contextOverride
              ? 'export DOCKER_HOST=unix:///var/run/docker.sock DOCKER_CONTEXT=remote; '
              : remote
              ? 'export DOCKER_HOST=tcp://remote:2375; '
              : ''
          }exec sh "${unix(script)}" ${helperPid === undefined ? '' : `--helper-pid ${helperPid}`}`,
        ],
        env: { CALLS: unix(calls), ...fixtureEnv },
        stdout: 'piped',
        stderr: 'piped',
      }).output();
    const output = await run();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assertEquals((await run(false, false, {}, 42)).code, 0);
    assertEquals((await run(false, false, {}, 1)).code, 1);
    assertEquals((await run(false, false, {}, 99)).code, 1);
    const reportText = new TextDecoder().decode(output.stdout);
    const report = JSON.parse(reportText);
    assertEquals(report.containers[0].listeningPorts, [32400]);
    const proposal = dockerStorage(reportText, [{
      key: 'plex:2',
      name: 'Plex TV',
      roots: ['/data/TV'],
      libraryKeys: ['2'],
      connectionHost: '192.168.1.10',
      connectionPort: 32400,
      configurationIdentity: 'fixture',
      connectionTestedAt: Date.now(),
    }], []);
    assertEquals(proposal.preview.status, 'confirmation_required');
    const commands = await Deno.readTextFile(calls);
    assert(!/\.Env|\.Labels|\.Cmd|\.Args/.test(commands));
    assertEquals((await run(true)).code, 1);
    assertEquals((await run(false, true)).code, 1);
    assertEquals((await run(false, false, { FIXTURE_OS: 'Darwin' })).code, 1);
    assertEquals(
      (await run(false, false, { FIXTURE_KERNEL: '6.6-microsoft-standard-WSL2' })).code,
      1,
    );
    assertEquals(
      (await run(false, false, { FIXTURE_DAEMON: 'Docker Desktop docker-desktop' })).code,
      1,
    );
    assert(!reportText.includes('pid='));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
