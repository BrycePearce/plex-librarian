import { assert, assertEquals } from '@std/assert';
import type { ServicePathRoot, ServiceStorageEndpoint } from '../../../../shared/serviceStorage.ts';
import { configuredStoragePath } from '../../../../shared/serviceStorage.ts';
import { automaticStorage } from './automaticStorage.ts';

const endpoints: ServiceStorageEndpoint[] = [
  { key: 'plex:2', name: 'Plex TV', roots: ['/data/TV'], libraryKeys: ['2'] },
  { key: 'arr:1', name: 'Sonarr', roots: ['/data/TV'], libraryKeys: ['2'] },
  { key: 'qb:1', name: 'QB', roots: ['/data/.torrents/complete'], libraryKeys: ['2'] },
].map((endpoint) => ({ ...endpoint, configurationIdentity: endpoint.key, connectionTestedAt: 1 }));

function accepted(): ServicePathRoot[] {
  const proposal = automaticStorage(endpoints, []).proposal!;
  return proposal.relationships.map((root, index) => ({
    ...root,
    serverId: 1,
    id: index + 1,
    revision: 1,
  }));
}

Deno.test('automatic setup proposes one shared assertion without granting discovery authority', () => {
  const roots: ServicePathRoot[] = [];
  const result = automaticStorage(endpoints, roots);
  assertEquals(result.status, 'confirmation_required');
  assertEquals(result.proposal?.relationships.length, 3);
  assertEquals(roots, []);
  assertEquals(result.proposal?.sharedRoot, '/data');
  assertEquals(
    automaticStorage(endpoints.map((endpoint) => ({ ...endpoint, connectionTestedAt: 5 })), [])
      .proposal?.fingerprint,
    result.proposal?.fingerprint,
  );
});

Deno.test('confirmed shared roots reuse across future titles and preserve folder overlap', () => {
  const roots = accepted();
  assertEquals(automaticStorage(endpoints, roots).status, 'ready');
  assertEquals(
    configuredStoragePath(roots, 'plex:2', '/data/TV/Next title/file.mkv'),
    '/data/TV/Next title/file.mkv',
  );
  assertEquals(
    configuredStoragePath(roots, 'qb:1', '/data/TV/Next title/file.mkv'),
    '/data/TV/Next title/file.mkv',
  );
});

Deno.test('stale, aliased and overlapping required roots never become automatic authority', () => {
  const roots = accepted();
  const required = roots.find((root) => root.serviceKey === 'plex:2')!;
  for (
    const changed of [
      roots.map((root) =>
        root.id !== required.id ? root : { ...root, configurationIdentity: 'changed' }
      ),
      roots.map((root) => root.id !== required.id ? root : { ...root, hasAliases: true }),
      [...roots, { ...required, id: 4, serviceRoot: '/data/TV' }],
      [...roots, { ...required, id: 4, serviceRoot: '/data/TV/Nested' }],
    ]
  ) assertEquals(automaticStorage(endpoints, changed).status, 'unavailable');
});

Deno.test('optional Arr failure does not block Plex/QB confirmation but QB remains a required dependency', () => {
  const offlineArr = endpoints.map((endpoint) =>
    endpoint.key === 'arr:1'
      ? { ...endpoint, connectionTestedAt: undefined, discoveryError: 'Offline', roots: [] }
      : endpoint
  );
  const proposal = automaticStorage(offlineArr, []);
  assertEquals(proposal.status, 'confirmation_required');
  assertEquals(proposal.proposal!.relationships.map((root) => root.serviceKey), ['plex:2', 'qb:1']);
  assertEquals(proposal.unavailableServices?.map((service) => service.serviceKey), ['arr:1']);
  const roots = proposal.proposal!.relationships.map((root, index) => ({
    ...root,
    id: index + 1,
    serverId: 1,
    revision: 1,
  }));
  const ready = automaticStorage(offlineArr, roots);
  assertEquals(ready.status, 'ready');
  assertEquals(ready.unavailableServices?.map((service) => service.serviceKey), ['arr:1']);
  assertEquals(
    automaticStorage(
      offlineArr.map((endpoint) =>
        endpoint.key === 'qb:1'
          ? { ...endpoint, connectionTestedAt: undefined, discoveryError: 'Offline' }
          : endpoint
      ),
      [],
    ).status,
    'unavailable',
  );
  const staleArr = [...roots, {
    ...accepted().find((root) => root.serviceKey === 'arr:1')!,
    id: 10,
    configurationIdentity: 'stale',
  }];
  assertEquals(
    automaticStorage(endpoints, staleArr).unavailableServices?.map((service) => service.serviceKey),
    ['arr:1'],
  );
  assertEquals(staleArr.at(-1)!.configurationIdentity, 'stale');
});

Deno.test('proposal binds discovery, current connections and saved revisions', () => {
  const initial = automaticStorage(endpoints, []).proposal!.fingerprint;
  for (
    const changed of [
      endpoints.map((endpoint, i) => i ? endpoint : { ...endpoint, roots: ['/data/Other'] }),
      endpoints.map((endpoint, i) => i ? endpoint : { ...endpoint, configurationIdentity: 'new' }),
    ]
  ) assert(automaticStorage(changed, []).proposal!.fingerprint !== initial);
  const partial = accepted().slice(0, 1);
  const first = automaticStorage(endpoints, partial).proposal!.fingerprint;
  assert(
    first !==
      automaticStorage(endpoints, partial.map((root) => ({ ...root, revision: 2 }))).proposal!
        .fingerprint,
  );
});

Deno.test('incomplete discovery and unsupported translations remain explicitly unavailable', () => {
  for (
    const first of [
      { ...endpoints[0], roots: [] },
      { ...endpoints[0], discoveryError: 'Unavailable' },
      { ...endpoints[0], roots: ['/tv'] },
      { ...endpoints[0], roots: ['/database/TV'] },
    ]
  ) assertEquals(automaticStorage([first, ...endpoints.slice(1)], []).status, 'unavailable');
});

Deno.test('music does not require setup and Plex alone needs no relationship', () => {
  assertEquals(automaticStorage([endpoints[0]], []).status, 'ready');
  const result = automaticStorage([...endpoints, {
    ...endpoints[0],
    key: 'plex:music',
    roots: [],
    supportedMedia: false,
  }], []);
  assertEquals(result.status, 'confirmation_required');
  assertEquals(result.proposal?.relationships.length, 3);
});

Deno.test('existing translated mappings reuse without replacing their authority', () => {
  const translated = endpoints.map((endpoint) => ({ ...endpoint, roots: ['/media/TV'] }));
  const roots = accepted().map((root) => ({
    ...root,
    serviceRoot: '/media',
    storageRoot: '/storage',
  }));
  assertEquals(automaticStorage(translated, roots).status, 'ready');
  const partial = automaticStorage(endpoints, [roots[0]]);
  assertEquals(partial.status, 'confirmation_required');
  assertEquals(partial.proposal!.relationships.map((root) => root.serviceKey), ['plex:2', 'qb:1']);
  assertEquals(partial.unavailableServices?.map((service) => service.serviceKey), ['arr:1']);
  assertEquals(roots[0].serviceRoot, '/media');
  assertEquals(roots[0].storageRoot, '/storage');
});

Deno.test('Plex-only readiness requires a tested movie or TV connection but not root discovery', () => {
  assertEquals(automaticStorage([], []).status, 'unavailable');
  assertEquals(
    automaticStorage([{ ...endpoints[0], connectionTestedAt: undefined }], []).status,
    'unavailable',
  );
  assertEquals(
    automaticStorage([{ ...endpoints[0], roots: [], discoveryError: 'No roots' }], []).status,
    'ready',
  );
});
