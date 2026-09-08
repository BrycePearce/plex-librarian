import { assertEquals, assertRejects } from '@std/assert';
import { ArrClient } from './arr/client.ts';
import { QbittorrentClient } from './qbittorrent/client.ts';
import type { ServiceDeletionResponse } from '../../../shared/serviceStorage.ts';

Deno.test('Arr ordinary deletion records HTTP success versus acceptance and always requests files', async () => {
  for (const status of [200, 202, 204]) {
    const calls: RequestInit[] = [];
    const outcomes: ServiceDeletionResponse[] = [];
    const client = new ArrClient(
      'sonarr',
      'http://fixture.invalid',
      'fixture',
      ((_url, init) => {
        calls.push(init!);
        return Promise.resolve(new Response(null, { status }));
      }) as typeof fetch,
    );
    await client.deleteMedia(9, false, (result) => outcomes.push(result));
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, 'DELETE');
    assertEquals(outcomes, [{
      status: status === 202 ? 'accepted' : 'succeeded',
      httpStatus: status,
    }]);
  }
});
Deno.test('Arr errors and ambiguous successful bodies never report deletion success', async () => {
  for (
    const body of [
      '{"error":"denied"}',
      '{"message":"denied"}',
      '"Failed"',
      '<html>Login</html>',
      '[]',
    ]
  ) {
    const client = new ArrClient(
      'sonarr',
      'http://fixture.invalid',
      'fixture',
      (() => Promise.resolve(new Response(body))) as typeof fetch,
    );
    const outcomes: ServiceDeletionResponse[] = [];
    await assertRejects(() => client.deleteMedia(9, false, (result) => outcomes.push(result)));
    assertEquals(outcomes, []);
  }
});
Deno.test('ordinary QB deletion accepts its normal response without job or physical absence polling', async () => {
  for (const body of ['', 'Ok.', 'Fails.']) {
    const calls: string[] = [];
    const outcomes: ServiceDeletionResponse[] = [];
    const client = new QbittorrentClient(
      'http://fixture.invalid',
      '',
      '',
      ((url, init) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        if (path.endsWith('/app/version')) return Promise.resolve(new Response('v5.0.0'));
        if (path.endsWith('/torrents/delete')) {
          assertEquals(new URLSearchParams(String(init?.body)).get('deleteFiles'), 'true');
          return Promise.resolve(new Response(body));
        }
        throw new Error(`Unexpected fixture request ${path}`);
      }) as typeof fetch,
    );
    if (body === 'Fails.') {
      await assertRejects(() => client.deleteTorrent('hash', (result) => outcomes.push(result)));
    } else await client.deleteTorrent('hash', (result) => outcomes.push(result));
    assertEquals(outcomes.length, body === 'Fails.' ? 0 : 1);
    if (outcomes.length) assertEquals(outcomes[0].status, 'accepted');
    assertEquals(calls.some((path) => path.includes('torrents/info')), false);
  }
});
