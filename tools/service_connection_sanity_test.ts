import { deepStrictEqual as equal } from 'node:assert/strict';
import {
  type ConnectionSnapshot,
  discoverCandidateTranslations,
} from './service_connection_sanity.ts';

function fixture(): ConnectionSnapshot {
  const fields = (data: Record<string, unknown>) =>
    Object.entries(data).map(([name, value]) => ({ name, value }));
  return {
    plexUrl: 'http://plex.invalid:32400',
    qbUrl: 'http://qb.invalid:8080',
    notifications: [{
      implementation: 'PlexServer',
      fields: fields({
        host: 'plex.invalid',
        port: 32400,
        useSsl: false,
        mapFrom: '/tv',
        mapTo: '/media/tv',
        authToken: 'never-return-this',
      }),
    }],
    downloadClients: [{
      implementation: 'QBittorrent',
      fields: fields({
        host: 'qb.invalid',
        port: 8080,
        useSsl: false,
        password: 'never-return-this',
      }),
    }],
    remoteMappings: [{ host: 'qb.invalid', remotePath: '/downloads', localPath: '/imports' }],
  };
}
const resolve = (s: ConnectionSnapshot) =>
  discoverCandidateTranslations(s, '/tv/Show', '/downloads/current');

Deno.test('service connection probe extracts candidate Plex and QB translations without exposing secret fields', () => {
  equal(resolve(fixture()), {
    plex: { arrPrefix: '/tv', plexPrefix: '/media/tv' },
    qb: { arrPrefix: '/imports', qbPrefix: '/downloads' },
  });
});
Deno.test('working notification with empty maps is not a declaration of Plex storage identity', () => {
  const s = fixture();
  s.notifications[0].fields = s.notifications[0].fields.filter((f) =>
    !['mapFrom', 'mapTo'].includes(f.name)
  );
  equal(resolve(s).plex, undefined);
  s.remoteMappings = [];
  equal(resolve(s).qb, undefined);
});

Deno.test('explicit Plex scan mapping can describe a separate copy and cannot authorize shared-entry reconciliation', () => {
  const configured = fixture();
  const shared = {
    settings: structuredClone(configured),
    arrEntry: '/host/library/Show/file.mkv',
    plexEntry: '/host/library/Show/file.mkv',
  };
  const copied = {
    settings: structuredClone(configured),
    arrEntry: '/host/library/Show/file.mkv',
    plexEntry: '/host/plex-copy/Show/file.mkv',
  };
  equal(shared.settings, copied.settings);
  equal(resolve(shared.settings), resolve(copied.settings));
  equal(shared.arrEntry === shared.plexEntry, true);
  equal(copied.arrEntry === copied.plexEntry, false);
  // Refreshing the mapped Plex section is valid in both worlds. Deleting Arr only
  // removes the Plex entry in one world; a successful scan/config test cannot tell.
});
Deno.test('service connection probe cannot reuse another host, port, scheme, base path or implementation', () => {
  for (
    const [name, value] of [['host', 'other.invalid'], ['port', 8081], ['useSsl', true], [
      'urlBase',
      '/proxy',
    ]] as const
  ) {
    const s = fixture();
    s.downloadClients[0].fields = s.downloadClients[0].fields.filter((f) => f.name !== name).concat(
      { name, value },
    );
    equal(resolve(s).qb, undefined);
  }
  const s = fixture();
  s.notifications[0].implementation = 'OtherService';
  equal(resolve(s).plex, undefined);
});
Deno.test('ambiguous connection records and overlapping remote mappings require resolution', () => {
  const s = fixture();
  s.notifications.push(structuredClone(s.notifications[0]));
  equal(resolve(s).plex, undefined);
  s.remoteMappings.push({
    host: 'qb.invalid',
    remotePath: '/downloads/current',
    localPath: '/different',
  });
  equal(resolve(s).qb, undefined);
});
Deno.test('mapping evidence stays inside its declared prefix and never implies host loopback identity', () => {
  const s = fixture();
  equal(discoverCandidateTranslations(s, '/tv-other/Show', '/downloads-other').plex, undefined);
  equal(discoverCandidateTranslations(s, '/tv-other/Show', '/downloads-other').qb, undefined);
  s.qbUrl = 'http://localhost:8080';
  s.downloadClients[0].fields.find((f) => f.name === 'host')!.value = 'localhost';
  s.remoteMappings[0].host = 'localhost';
  equal(resolve(s).qb, undefined);
});
