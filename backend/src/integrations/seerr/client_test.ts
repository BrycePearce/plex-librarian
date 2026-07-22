import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { normalizeSeerrUrl, SeerrApiError, SeerrClient } from './client.ts';

Deno.test('normalizeSeerrUrl accepts a configured base or API URL', () => {
  assertEquals(normalizeSeerrUrl('http://seerr:5055/'), 'http://seerr:5055');
  assertEquals(
    normalizeSeerrUrl('https://media.example/seerr/api/v1'),
    'https://media.example/seerr',
  );
});

Deno.test('normalizeSeerrUrl rejects credentials embedded in a browser-visible URL', () => {
  assertThrows(
    () => normalizeSeerrUrl('http://admin:secret@seerr:5055'),
    Error,
    'URL must not include credentials',
  );
});

Deno.test(
  'Seerr connection test verifies status and authenticated request access',
  async () => {
    const requested: Array<{ url: string; apiKey: string | null }> = [];
    const client = new SeerrClient(
      'http://seerr:5055',
      'secret',
      (input, init) => {
        const url = String(input);
        requested.push({
          url,
          apiKey: new Headers(init?.headers).get('X-Api-Key'),
        });
        return Promise.resolve(
          url.endsWith('/status')
            ? new Response(JSON.stringify({ version: '2.7.1' }))
            : new Response(
              JSON.stringify({ pageInfo: { results: 0 }, results: [] }),
            ),
        );
      },
    );

    assertEquals(await client.testConnection(), { version: '2.7.1' });
    assertEquals(requested, [
      { url: 'http://seerr:5055/api/v1/status', apiKey: 'secret' },
      {
        url: 'http://seerr:5055/api/v1/request?take=1&skip=0',
        apiKey: 'secret',
      },
    ]);
  },
);

Deno.test('Seerr connection test rejects an invalid API key', async () => {
  const client = new SeerrClient('http://seerr:5055', 'wrong', (input) =>
    Promise.resolve(
      String(input).endsWith('/status')
        ? new Response(JSON.stringify({ version: '2.7.1' }))
        : new Response('Unauthorized', { status: 401 }),
    ));

  const error = await assertRejects(
    () => client.testConnection(),
    SeerrApiError,
  );
  assertEquals(error.status, 401);
});
