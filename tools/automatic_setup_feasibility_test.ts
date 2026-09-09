/** Isolated feasibility probe, not application setup or deletion authorization.
 * A confirmed namespace is trusted configuration, not inferred from matching paths.
 * Run: deno test tools/automatic_setup_feasibility_test.ts
 */
import {
  deepStrictEqual as assertEquals,
  notDeepStrictEqual as assertNotEquals,
  throws as assertThrows,
} from 'node:assert/strict';
import {
  configuredStoragePath,
  type ServicePathRoot,
  storageContains,
} from '../shared/serviceStorage.ts';

type Endpoint = { key: string; identity: string; roots: string[] };
type Confirmation = {
  prefix: string;
  members: Array<{ key: string; identity: string }>;
};
const endpoints: Endpoint[] = [
  { key: 'plex:1', identity: 'plex-server', roots: ['/data/Movies'] },
  { key: 'plex:2', identity: 'plex-server', roots: ['/data/TV'] },
  { key: 'plex:3', identity: 'plex-server', roots: ['/data/Anime'] },
  { key: 'arr:3', identity: 'sonarr-instance', roots: ['/data/TV', '/data/Anime'] },
  { key: 'qb:db:4', identity: 'qb-instance', roots: ['/data/.torrents/complete'] },
];
const confirmation: Confirmation = {
  prefix: '/data',
  members: endpoints.map(({ key, identity }) => ({ key, identity })),
};

// Prototype of mechanical expansion AFTER one explicit group confirmation.
// No UI or production persistence is implemented by this probe.
function expandConfirmedGroup(
  discovered: Endpoint[],
  accepted?: Confirmation,
): ServicePathRoot[] {
  if (!accepted) return [];
  return discovered.filter((endpoint) =>
    accepted.members.some((member) =>
      member.key === endpoint.key && member.identity === endpoint.identity
    ) && endpoint.roots.every((root) => storageContains(accepted.prefix, root))
  ).map((endpoint, index) => ({
    id: index + 1,
    serverId: 1,
    serviceKey: endpoint.key,
    configurationIdentity: endpoint.identity,
    serviceRoot: accepted.prefix,
    storageRoot: '/confirmed-storage',
    caseSensitive: true,
    hasAliases: false,
    revision: 1,
  }));
}

Deno.test('discovered matching prefixes alone do not establish a storage relationship', () => {
  const roots = expandConfirmedGroup(endpoints);
  assertEquals(roots, []);
  assertThrows(() => configuredStoragePath(roots, 'plex:2', '/data/TV/Mad Men/episode.mkv'));
});

Deno.test('one confirmed shared namespace expands across services and libraries without per-root input', () => {
  const roots = expandConfirmedGroup(endpoints, confirmation);
  assertEquals(roots.length, 5);
  assertEquals(
    configuredStoragePath(roots, 'plex:2', '/data/TV/Mad Men/episode.mkv'),
    configuredStoragePath(roots, 'arr:3', '/data/TV/Mad Men/episode.mkv'),
  );
  const show = configuredStoragePath(roots, 'arr:3', '/data/TV/Mad Men');
  const download = configuredStoragePath(roots, 'qb:db:4', '/data/.torrents/complete/pack');
  assertEquals(storageContains(show, download), false);
});

Deno.test('group expansion preserves exact-entry and containing-folder QB protection', () => {
  const roots = expandConfirmedGroup(endpoints, confirmation);
  const show = configuredStoragePath(roots, 'arr:3', '/data/TV/Mad Men');
  const entry = configuredStoragePath(roots, 'qb:db:4', '/data/TV/Mad Men/episode.mkv');
  assertEquals(storageContains(show, entry), true);
  assertEquals(entry, configuredStoragePath(roots, 'plex:2', '/data/TV/Mad Men/episode.mkv'));
});

Deno.test('existing confirmation covers future media under its prefix, not changed identities or uncovered roots', () => {
  const later = structuredClone(endpoints);
  later[0].roots.push('/data/newmovies');
  let roots = expandConfirmedGroup(later, confirmation);
  assertEquals(
    configuredStoragePath(roots, 'plex:1', '/data/newmovies/new.mkv'),
    '/confirmed-storage/newmovies/new.mkv',
  );
  later[0].identity = 'another-plex-server';
  roots = expandConfirmedGroup(later, confirmation);
  assertThrows(() => configuredStoragePath(roots, 'plex:1', '/data/Movies/new.mkv'));
  later[1].roots.push('/other-volume/TV');
  roots = expandConfirmedGroup(later, confirmation);
  assertThrows(() => configuredStoragePath(roots, 'plex:2', '/other-volume/TV/new.mkv'));
});

Deno.test('identical API observations can conceal opposite folder-overlap outcomes', () => {
  const observations = {
    sonarrFolder: '/data/TV/Mad Men',
    qbContent: '/downloads/pack/episode.mkv',
    hash: 'fixture-hash',
    fileSize: 100,
  };
  const independent = { observations, qbHostEntry: '/pool/downloads/pack/episode.mkv' };
  const overlapping = {
    observations: structuredClone(observations),
    qbHostEntry: '/pool/TV/Mad Men/pack/episode.mkv',
  };
  assertEquals(independent.observations, overlapping.observations);
  const actualFolder = '/pool/TV/Mad Men';
  assertNotEquals(
    storageContains(actualFolder, independent.qbHostEntry),
    storageContains(actualFolder, overlapping.qbHostEntry),
  );
  // The download may be a separate directory or live inside the series folder.
  // Matching service IDs, names, sizes, and histories cannot distinguish these
  // two mount layouts; a reusable namespace needs configuration evidence.
});
