import { assertEquals, assertRejects } from '@std/assert';
import { PlexConnectionError, selectReachablePlexUrl } from './serverConnection.ts';

function identity(machineIdentifier: string, status = 200): Response {
  return Response.json({ MediaContainer: { machineIdentifier } }, { status });
}

Deno.test('selectReachablePlexUrl prefers the first reachable matching server', async () => {
  const requested: string[] = [];
  const result = await selectReachablePlexUrl(
    ['http://local:32400/', 'https://direct.example:32400', 'https://relay.example'],
    'token',
    'client',
    'expected',
    ((input) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith('http://local')) return Promise.reject(new TypeError('unreachable'));
      return Promise.resolve(identity('expected'));
    }) as typeof fetch,
  );

  assertEquals(result, 'https://direct.example:32400');
  assertEquals(requested, [
    'http://local:32400/identity',
    'https://direct.example:32400/identity',
    'https://relay.example/identity',
  ]);
});

Deno.test('selectReachablePlexUrl rejects an address for a different server', async () => {
  await assertRejects(
    () =>
      selectReachablePlexUrl(
        ['http://wrong-server:32400'],
        'token',
        'client',
        'expected',
        (() => Promise.resolve(identity('different'))) as typeof fetch,
      ),
    PlexConnectionError,
    "couldn't reach this server",
  );
});

Deno.test('selectReachablePlexUrl ignores invalid and duplicate addresses', async () => {
  let calls = 0;
  const result = await selectReachablePlexUrl(
    ['file:///etc/passwd', 'not a URL', 'http://plex:32400', 'http://plex:32400/'],
    'token',
    'client',
    'expected',
    (() => {
      calls++;
      return Promise.resolve(identity('expected'));
    }) as typeof fetch,
  );

  assertEquals(result, 'http://plex:32400');
  assertEquals(calls, 1);
});
