/** Provisions only the explicitly named fresh acceptance Sonarr/QB containers. */
const project = 'librarian-helper-free-acceptance';
const context = 'desktop-linux';
const runtime = new URL('./.runtime/', import.meta.url);
const localPath = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
async function docker(args: string[]) {
  const result = await new Deno.Command('docker', {
    args: ['--context', context, ...args],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!result.success) throw new Error(`Disposable Docker ${args[0]} failed`);
  return new TextDecoder().decode(result.stdout);
}
for (const service of ['sonarr', 'qb']) {
  const [container] = JSON.parse(await docker(['inspect', `${project}-${service}-1`]));
  if (
    container.Config.Labels['com.docker.compose.project'] !== project ||
    container.Config.Labels['com.docker.compose.service'] !== service ||
    !container.Mounts.some((m: { Name: string }) => m.Name === `${project}_fixture-media`)
  ) {
    throw new Error('Disposable container/volume ownership mismatch');
  }
}
const credentials = JSON.parse(await Deno.readTextFile(new URL('credentials.json', runtime)));
const qbLogs = await docker(['logs', `${project}-qb-1`]);
const password = credentials.qbPassword ??
  /temporary password[^\r\n]*?:\s*(\S+)/i.exec(qbLogs)?.[1];
if (!password) {
  throw new Error('Fresh QB temporary password unavailable; do not print startup logs');
}

const loginProcess = new Deno.Command('docker', {
  args: [
    '--context',
    context,
    'exec',
    '-i',
    `${project}-qb-1`,
    'curl',
    '-s',
    '-D',
    '-',
    '-o',
    '/dev/null',
    '--data-binary',
    '@-',
    '-H',
    'Referer: http://127.0.0.1:8080/',
    'http://127.0.0.1:8080/api/v2/auth/login',
  ],
  stdin: 'piped',
  stdout: 'piped',
  stderr: 'piped',
}).spawn();
const loginWriter = loginProcess.stdin.getWriter();
await loginWriter.write(
  new TextEncoder().encode(new URLSearchParams({ username: 'acceptance', password }).toString()),
);
await loginWriter.close();
const loginResult = await loginProcess.output();
const loginHeaders = new TextDecoder().decode(loginResult.stdout);
const cookie = /set-cookie:\s*([^;\r\n]+)/i.exec(loginHeaders)?.[1];
if (!loginResult.success || !cookie) throw new Error('Disposable loopback QB login failed');
async function qb(path: string, body?: FormData | URLSearchParams) {
  const request = new Request(`http://127.0.0.1:8080/api/v2/${path}`, {
    method: body ? 'POST' : 'GET',
    body,
  });
  const args = [
    '--context',
    context,
    'exec',
    '-i',
    `${project}-qb-1`,
    'curl',
    '-s',
    '-w',
    '\n%{http_code}',
    '-H',
    `Cookie: ${cookie}`,
    '-H',
    'Referer: http://127.0.0.1:8080/',
  ];
  if (body) {
    args.push('--data-binary', '@-', '-H', `Content-Type: ${request.headers.get('content-type')}`);
  }
  args.push(request.url);
  const process = new Deno.Command('docker', {
    args,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writer = process.stdin.getWriter();
  if (body) await writer.write(new Uint8Array(await request.arrayBuffer()));
  await writer.close();
  const result = await process.output();
  const output = new TextDecoder().decode(result.stdout);
  const split = output.lastIndexOf('\n');
  const status = Number(output.slice(split + 1));
  if (!result.success || status < 200 || status >= 300) {
    throw new Error(`Disposable QB ${path.split('?')[0]} HTTP ${status}`);
  }
  return new Response(status === 204 ? null : output.slice(0, split), { status });
}
async function sonarr(path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:18989/api/v3/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Api-Key': credentials.sonarrApiKey, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Sonarr ${path.split('?')[0]} HTTP ${response.status}`);
  return response.json();
}

export { credentials, docker, localPath, project, qb, runtime, sonarr };
