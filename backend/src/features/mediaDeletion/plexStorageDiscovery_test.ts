import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { PlexClient } from '../../integrations/plex/client.ts';
import { plexStorageDiscovery } from './plexStorageDiscovery.ts';

Deno.test('setup shares one bounded Plex discovery across libraries without caching later requests', async () => {
  const requests: string[] = [];
  const client = new PlexClient(
    'http://fixture.invalid',
    'fixture-token',
    undefined,
    ((input) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      return Promise.resolve(Response.json({
        MediaContainer: path === '/identity' ? { machineIdentifier: 'fixture' } : {
          Directory: [
            { key: '1', Location: [{ id: 1, path: '/data/Movies' }] },
            { key: '2', Location: [{ id: 2, path: '/data/TV' }] },
            { key: '3', Location: [] },
          ],
        },
      }));
    }) as typeof fetch,
  );
  const discovery = await plexStorageDiscovery(client);
  assertEquals(typeof discovery.connectionTestedAt, 'number');
  assertEquals(discovery.read!('1').locations[0].path, '/data/Movies');
  assertEquals(discovery.read!('2').locations[0].path, '/data/TV');
  assertThrows(() => discovery.read!('3'));
  assertThrows(() => discovery.read!('missing'));
  assertEquals(requests, ['/identity', '/library/sections']);
  await plexStorageDiscovery(client);
  assertEquals(requests, ['/identity', '/library/sections', '/identity', '/library/sections']);
});

Deno.test('setup distinguishes valid Plex connection with unavailable roots from failed identity', async () => {
  const connected = await plexStorageDiscovery({
    identity: () => Promise.resolve('fixture'),
    libraryLocationReader: () => Promise.reject(new Error('Malformed roots')),
  });
  assertEquals(typeof connected.connectionTestedAt, 'number');
  assertEquals(connected.read, undefined);
  let listings = 0;
  await assertRejects(() =>
    plexStorageDiscovery({
      identity: () => Promise.resolve(''),
      libraryLocationReader: () => {
        listings++;
        throw new Error('Should not list');
      },
    })
  );
  assertEquals(listings, 0);
});
