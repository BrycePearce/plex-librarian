import { assertEquals } from '@std/assert';
import type { ServiceStorageEndpoint } from '../../../../shared/serviceStorage.ts';
import { resolveDiscoveryAddresses } from './discoveryAddresses.ts';
const endpoint = (connectionHost: string): ServiceStorageEndpoint => ({
  key: 'plex:1',
  name: 'Plex',
  roots: [],
  libraryKeys: ['1'],
  connectionHost,
  configurationIdentity: 'configured',
});
Deno.test('hostname lookup deduplicates libraries, keeps literal Docker addresses, and refreshes DNS', async () => {
  const endpoints = ['plex.direct', 'plex.direct', 'sonarr', '192.168.1.10', '[::1]'].map(endpoint);
  const calls: string[] = [];
  const lookup = (host: string, type: 'A' | 'AAAA') => {
    calls.push(`${host}:${type}`);
    return Promise.resolve(type === 'A' ? ['172.20.0.2'] : []);
  };
  assertEquals(await resolveDiscoveryAddresses(endpoints, ['sonarr'], lookup), {
    'plex.direct': ['172.20.0.2'],
  });
  assertEquals(calls, ['plex.direct:A', 'plex.direct:AAAA']);
  assertEquals(
    await resolveDiscoveryAddresses(endpoints, ['sonarr'], () => Promise.resolve(['172.20.0.4'])),
    {
      'plex.direct': ['172.20.0.4'],
    },
  );
});
Deno.test('failed or partial DNS responses cannot become known local container evidence', async () => {
  const endpoints = [endpoint('plex.direct')];
  for (const error of [new Error('timeout'), new Deno.errors.PermissionDenied()]) {
    assertEquals(
      await resolveDiscoveryAddresses(
        endpoints,
        [],
        (_host, type) => type === 'A' ? Promise.resolve(['172.20.0.2']) : Promise.reject(error),
      ),
      { 'plex.direct': [] },
    );
  }
  assertEquals(
    await resolveDiscoveryAddresses(
      endpoints,
      [],
      (_host, type) =>
        type === 'A' ? Promise.resolve(['172.20.0.2']) : Promise.reject(new Deno.errors.NotFound()),
    ),
    { 'plex.direct': ['172.20.0.2'] },
  );
  assertEquals(
    await resolveDiscoveryAddresses(endpoints, [], () => Promise.resolve(['not-an-IP'])),
    {
      'plex.direct': [],
    },
  );
});
