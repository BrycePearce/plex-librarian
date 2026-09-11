import { assert, assertEquals, assertThrows } from '@std/assert';
import type { ServicePathRoot, ServiceStorageEndpoint } from '../../../../shared/serviceStorage.ts';
import { dockerStorage } from './dockerStorage.ts';
import { configuredStoragePath } from '../../../../shared/serviceStorage.ts';
const now = Date.parse('2026-09-08T10:00:00Z');
function fixture() {
  const containers = ['plex', 'sonarr', 'qb'].map((name, index) => ({
    Id: `id-${name}`,
    Name: `/${name}`,
    State: { Running: true },
    NetworkMode: 'bridge',
    volumeSubpaths: [] as Array<{ Destination: string; Subpath: string }>,
    tmpfsTargets: [] as string[],
    nonRecursiveBindTargets: [] as string[],
    Networks: [{
      Name: 'bridge',
      IPAddress: `172.20.0.${index + 2}`,
      GlobalIPv6Address: '',
      Aliases: [name],
    }],
    Ports: [{ containerPort: 8000 + index, hostPort: 8000 + index, hostIp: '0.0.0.0' }],
    Mounts: [{
      Type: 'bind',
      Source: '/mnt/user/media',
      Destination: name === 'plex' ? '/media' : '/data',
    }],
    listeningPorts: [] as number[],
  }));
  const report = {
    version: 3,
    daemonId: 'daemon-one',
    generatedAt: new Date(now).toISOString(),
    hostAddresses: ['192.168.1.10'],
    containers,
  };
  const endpoints: ServiceStorageEndpoint[] = ['plex:2', 'arr:1', 'qb:1'].map((key, i) => ({
    key,
    name: key,
    configurationIdentity: key,
    connectionTestedAt: now,
    connectionHost: containers[i].Name.slice(1),
    connectionPort: 8000 + i,
    libraryKeys: ['2'],
    roots: [i === 0 ? '/media/TV' : i === 1 ? '/data/TV' : '/data/downloads'],
  }));
  return { report, endpoints };
}

Deno.test('same-host discovery matches Unraid host-network Plex and published Arr/QB without container choices', () => {
  const { report, endpoints } = fixture();
  for (const endpoint of endpoints) endpoint.connectionHost = report.hostAddresses[0];
  report.containers[0].NetworkMode = 'host';
  report.containers[0].listeningPorts = [endpoints[0].connectionPort!];
  const result = dockerStorage(JSON.stringify(report), endpoints, [], now);
  assertEquals(result.preview.status, 'confirmation_required');
  assertEquals(result.preview.services.map((service) => service.matchedBy), [
    'address',
    'address',
    'address',
  ]);
  const roots = result.relationships.map((root, i) => ({
    ...root,
    id: i,
    serverId: 1,
    revision: 1,
  }));
  assertEquals(
    configuredStoragePath(roots, 'plex:2', '/media/TV/Show/episode.mkv'),
    configuredStoragePath(roots, 'arr:1', '/data/TV/Show/episode.mkv'),
  );
});

Deno.test('same-host discovery distinguishes separate bind sources despite identical service-visible paths', () => {
  const { report, endpoints } = fixture();
  report.containers[0].Mounts[0].Destination = '/data';
  endpoints[0].roots = ['/data/TV'];
  report.containers[1].Mounts[0].Source = '/mnt/user/separate-copy';
  const result = dockerStorage(JSON.stringify(report), endpoints, [], now);
  assertEquals(result.preview.status, 'confirmation_required');
  const roots = result.relationships.map((root, i) => ({
    ...root,
    id: i,
    serverId: 1,
    revision: 1,
  }));
  assert(
    configuredStoragePath(roots, 'plex:2', '/data/TV/Show/episode.mkv') !==
      configuredStoragePath(roots, 'arr:1', '/data/TV/Show/episode.mkv'),
  );
});

Deno.test('fresh topology refresh reuses stable mappings but detects changed mounts and container replacement', () => {
  const { report, endpoints } = fixture();
  const first = dockerStorage(JSON.stringify(report), endpoints, [], now);
  const saved = first.relationships.map((root, i) => ({
    ...root,
    id: i,
    serverId: 1,
    revision: 1,
  }));
  report.generatedAt = new Date(now + 1000).toISOString();
  const stable = dockerStorage(JSON.stringify(report), endpoints, saved, now + 1000);
  assertEquals(stable.preview.status, 'ready');
  report.containers[1].Id = 'recreated-sonarr';
  const recreated = dockerStorage(JSON.stringify(report), endpoints, saved, now + 1000);
  assertEquals(recreated.preview.status, 'ready');
  assert(recreated.preview.fingerprint !== stable.preview.fingerprint);
  report.containers[1].Mounts[0].Source = '/mnt/user/new-media';
  const changed = dockerStorage(JSON.stringify(report), endpoints, saved, now + 1000);
  assertEquals(changed.preview.status, 'confirmation_required');
  assertEquals(changed.preview.replacementRequired, true);
  assert(changed.preview.fingerprint !== recreated.preview.fingerprint);
});

Deno.test('saved mappings cannot make a missing required container ready on the next host refresh', () => {
  const { report, endpoints } = fixture();
  const first = dockerStorage(JSON.stringify(report), endpoints, [], now);
  const saved = first.relationships.map((root, i) => ({
    ...root,
    id: i,
    serverId: 1,
    revision: 1,
  }));
  report.containers = report.containers.filter((container) => container.Id !== 'id-qb');
  const result = dockerStorage(JSON.stringify(report), endpoints, saved, now);
  assertEquals(result.preview.status, 'unavailable');
  assertEquals(result.relationships, []);
});
Deno.test('Docker report matches network identities and translates concrete bind sources without shared-path assumptions', () => {
  const { report, endpoints } = fixture();
  const result = dockerStorage(JSON.stringify(report), endpoints, [], now);
  assertEquals(result.preview.status, 'confirmation_required');
  assertEquals(result.relationships.length, 3);
  assertEquals(result.relationships[0].storageRoot, result.relationships[1].storageRoot);
  assertEquals(result.relationships[0].serviceRoot, '/media/TV');
  const saved = result.relationships.map((r, i) => ({ ...r, id: i + 1, serverId: 1, revision: 1 }));
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, saved, now).preview.status,
    'ready',
  );
});
Deno.test('Docker report blocks nested mounts before granting broad authority', () => {
  const { report, endpoints } = fixture();
  report.containers[0].Mounts.push({
    Type: 'bind',
    Source: '/other',
    Destination: '/media/TV/Other',
  });
  const result = dockerStorage(JSON.stringify(report), endpoints, [], now);
  assertEquals(result.preview.status, 'unavailable');
  assertEquals(result.relationships, []);
});
Deno.test('Docker report refuses name guesses, supports explicit identity choice, fingerprints that choice', () => {
  const { report, endpoints } = fixture();
  endpoints[0].connectionHost = 'proxy.example';
  const blocked = dockerStorage(JSON.stringify(report), endpoints, [], now);
  assertEquals(blocked.preview.status, 'unavailable');
  assertEquals(blocked.preview.services[0].candidates?.length, 3);
  const chosen = dockerStorage(JSON.stringify(report), endpoints, [], now, { 'plex:2': 'id-plex' });
  assertEquals(chosen.preview.status, 'confirmation_required');
  assertEquals(chosen.preview.services[0].matchedBy, 'selection');
  assertThrows(() =>
    dockerStorage(JSON.stringify(report), endpoints, [], now, { 'plex:2': 'unknown' })
  );
});
Deno.test('Docker host network needs an observed listener belonging to that container', () => {
  const { report, endpoints } = fixture();
  report.containers[0].NetworkMode = 'host';
  endpoints[0].connectionHost = '192.168.1.10';
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
    'unavailable',
  );
  report.containers[0].listeningPorts = [8000];
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
    'confirmation_required',
  );
});
Deno.test('Docker report is bounded, expires, and rejects unsupported mount types and unknown daemon', () => {
  const { report, endpoints } = fixture();
  assertThrows(() => dockerStorage(JSON.stringify(report), endpoints, [], now + 86_400_001));
  assertThrows(() => dockerStorage('x'.repeat(2_000_001), endpoints, [], now));
  report.daemonId = '';
  assertThrows(() => dockerStorage(JSON.stringify(report), endpoints, [], now));
  report.daemonId = 'one';
  report.containers[0].Mounts[0].Type = 'tmpfs';
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
    'unavailable',
  );
});
Deno.test('Docker setup never silently replaces previously confirmed authority or ignores connection changes', () => {
  const { report, endpoints } = fixture();
  const original = dockerStorage(JSON.stringify(report), endpoints, [], now);
  const saved: ServicePathRoot[] = original.relationships.map((r, i) => ({
    ...r,
    id: i,
    revision: 1,
    serverId: 1,
    storageRoot: r.serviceRoot,
  }));
  const replacement = dockerStorage(JSON.stringify(report), endpoints, saved, now);
  assert(replacement.preview.replacementRequired);
  saved[0].revision++;
  assert(
    replacement.preview.fingerprint !==
      dockerStorage(JSON.stringify(report), endpoints, saved, now).preview.fingerprint,
  );
  endpoints[0].configurationIdentity = 'changed';
  assert(
    original.preview.fingerprint !==
      dockerStorage(JSON.stringify(report), endpoints, [], now).preview.fingerprint,
  );
});
Deno.test('An unavailable optional Arr does not prevent verified Plex and QB setup', () => {
  const { report, endpoints } = fixture();
  endpoints[1].connectionTestedAt = undefined;
  const result = dockerStorage(JSON.stringify(report), endpoints, [], now);
  assertEquals(result.preview.status, 'confirmation_required');
  assertEquals(result.relationships.length, 2);
  assert(result.preview.services[1].reason);
});

Deno.test('Docker matching declines loopback, reverse proxies, duplicated addresses and stopped containers', () => {
  for (const mode of ['loopback', 'proxy', 'duplicate', 'stopped']) {
    const { report, endpoints } = fixture();
    if (mode === 'loopback') {
      endpoints[0].connectionHost = '127.0.0.1';
      report.hostAddresses.push('127.0.0.1');
    }
    if (mode === 'proxy') endpoints[0].connectionPath = '/plex';
    if (mode === 'duplicate') report.containers.push({ ...report.containers[0], Id: 'other' });
    if (mode === 'stopped') report.containers[0].State.Running = false;
    assertEquals(
      dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
      'unavailable',
      mode,
    );
  }
});
Deno.test('Docker media alias checks ignore unrelated mounts but reject Unraid user-share/disk mixtures', () => {
  const { report, endpoints } = fixture();
  report.containers[0].Mounts.push({
    Type: 'bind',
    Source: '/mnt/cache/appdata/plex',
    Destination: '/config',
  });
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
    'confirmation_required',
  );
  report.containers[1].Mounts[0].Source = '/mnt/disk1/media';
  assertThrows(() => dockerStorage(JSON.stringify(report), endpoints, [], now), Error, 'can alias');
});
Deno.test('Docker daemon identity separates reports and report content participates in accepted evidence', () => {
  const { report, endpoints } = fixture();
  const first = dockerStorage(JSON.stringify(report), endpoints, [], now);
  report.daemonId = 'other-daemon';
  const other = dockerStorage(JSON.stringify(report), endpoints, [], now);
  assert(first.relationships[0].storageRoot !== other.relationships[0].storageRoot);
  assert(first.preview.fingerprint !== other.preview.fingerprint);
});
Deno.test('Docker source aliases within a service and duplicate mount destinations remain blocked', () => {
  const { report, endpoints } = fixture();
  endpoints[0].roots.push('/second/TV');
  report.containers[0].Mounts.push({
    Type: 'bind',
    Source: '/mnt/user/media',
    Destination: '/second',
  });
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
    'unavailable',
  );
  endpoints[0].roots.pop();
  report.containers[0].Mounts.push({ ...report.containers[0].Mounts[0] });
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
    'unavailable',
  );
});

Deno.test('Docker named volumes require ordinary local driver metadata without options', () => {
  const { report, endpoints } = fixture();
  const named = { ...report, volumes: [{ Name: 'media', Driver: 'local', OptionsCount: 0 }] };
  Object.assign(named.containers[0].Mounts[0], {
    Type: 'volume',
    Name: 'media',
    Source: '/var/lib/docker/volumes/media/_data',
  });
  assertEquals(
    dockerStorage(JSON.stringify(named), endpoints, [], now).preview.status,
    'confirmation_required',
  );
  named.volumes[0].OptionsCount = 1;
  assertEquals(
    dockerStorage(JSON.stringify(named), endpoints, [], now).preview.status,
    'unavailable',
  );
  named.volumes[0].OptionsCount = 0;
  named.volumes[0].Driver = 'nfs';
  assertEquals(
    dockerStorage(JSON.stringify(named), endpoints, [], now).preview.status,
    'unavailable',
  );
});

Deno.test('Docker imports explicitly retire every old service outside the accepted namespace', () => {
  const { report, endpoints } = fixture();
  const first = dockerStorage(JSON.stringify(report), endpoints, [], now);
  const saved: ServicePathRoot[] = first.relationships.map((r, i) => ({
    ...r,
    id: i + 1,
    revision: 1,
    serverId: 1,
  }));
  saved.push({ ...saved[0], id: 4, serviceKey: 'arr:unmapped' });
  endpoints[1].connectionTestedAt = undefined;
  const result = dockerStorage(JSON.stringify(report), endpoints, saved, now);
  assertEquals(result.preview.status, 'confirmation_required');
  assert(result.preview.replacementRequired);
  assertEquals(result.preview.invalidatedServices?.map((s) => s.serviceKey), [
    'arr:1',
    'arr:unmapped',
  ]);
  assertEquals(result.relationships.length, 2);
});
Deno.test('Docker container names alone do not establish network identity', () => {
  const { report, endpoints } = fixture();
  report.containers[0].Networks[0].Aliases = [];
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
    'unavailable',
  );
});
Deno.test('Docker Desktop host path translations cannot establish case-sensitive storage', () => {
  for (
    const source of [
      '/host_mnt/c/Media',
      '/run/desktop/mnt/host/c/Media',
      '/mnt/host/c/Media',
      '/mnt/wsl/Media',
      '/Users/me/Media',
      '/c/Media',
    ]
  ) {
    const { report, endpoints } = fixture();
    report.containers[0].Mounts[0].Source = source;
    assertEquals(
      dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
      'unavailable',
      source,
    );
  }
});

Deno.test('Docker volume subpaths and classic tmpfs overlays are rejected only for affected media roots', () => {
  const { report, endpoints } = fixture();
  report.containers[0].volumeSubpaths = [{ Destination: '/media', Subpath: 'TV-only' }];
  const subpath = dockerStorage(JSON.stringify(report), endpoints, [], now);
  assertEquals(subpath.preview.status, 'unavailable');
  assert(subpath.preview.services[0].reason?.includes('volume subpath'));
  report.containers[0].volumeSubpaths = [{ Destination: '/unrelated', Subpath: 'config' }];
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
    'confirmation_required',
  );
  for (const path of ['/media', '/media/TV', '/media/TV/nested']) {
    report.containers[0].tmpfsTargets = [path];
    assertEquals(
      dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
      'unavailable',
      path,
    );
  }
  report.containers[0].tmpfsTargets = ['/tmp'];
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
    'confirmation_required',
  );
});
Deno.test('Incomplete or malformed mount override reports fail closed', () => {
  const { report, endpoints } = fixture();
  assertThrows(() => dockerStorage(JSON.stringify({ ...report, version: 1 }), endpoints, [], now));
  for (const field of ['tmpfsTargets', 'volumeSubpaths']) {
    const incomplete = JSON.parse(JSON.stringify(report));
    delete incomplete.containers[0][field];
    assertThrows(() => dockerStorage(JSON.stringify(incomplete), endpoints, [], now));
  }
  report.containers[0].volumeSubpaths = [{ Destination: '/media', Subpath: '../other' }];
  assertThrows(() => dockerStorage(JSON.stringify(report), endpoints, [], now));
  report.containers[0].volumeSubpaths = [];
  report.containers[0].tmpfsTargets = Array(201).fill('/tmp');
  assertThrows(() => dockerStorage(JSON.stringify(report), endpoints, [], now));
});

Deno.test('Non-recursive Docker binds cannot prove media relationships but unrelated binds do not block', () => {
  for (const path of ['/media', '/media/TV', '/media/TV/nested']) {
    const { report, endpoints } = fixture();
    report.containers[0].nonRecursiveBindTargets = [path];
    const result = dockerStorage(JSON.stringify(report), endpoints, [], now);
    assertEquals(result.preview.status, 'unavailable');
    assert(result.preview.services[0].reason?.includes('non-recursive'));
  }
  const { report, endpoints } = fixture();
  report.containers[0].nonRecursiveBindTargets = ['/config'];
  assertEquals(
    dockerStorage(JSON.stringify(report), endpoints, [], now).preview.status,
    'confirmation_required',
  );
  assertThrows(() => dockerStorage(JSON.stringify({ ...report, version: 2 }), endpoints, [], now));
  const incomplete = JSON.parse(JSON.stringify(report));
  delete incomplete.containers[0].nonRecursiveBindTargets;
  assertThrows(() => dockerStorage(JSON.stringify(incomplete), endpoints, [], now));
  report.containers[0].nonRecursiveBindTargets = ['/data/../TV'];
  assertThrows(() => dockerStorage(JSON.stringify(report), endpoints, [], now));
  report.containers[0].nonRecursiveBindTargets = Array(201).fill('/config');
  assertThrows(() => dockerStorage(JSON.stringify(report), endpoints, [], now));
});

Deno.test('Plex OAuth DNS addresses match real container evidence without decoding its hostname', () => {
  const { report, endpoints } = fixture();
  const hostname = '172-20-0-2.example.plex.direct';
  endpoints[0].connectionHost = hostname;
  const resolved = { [hostname]: ['172.20.0.2'] };
  const plan = (addresses: Record<string, string[]>) =>
    dockerStorage(JSON.stringify(report), endpoints, [], now, {}, true, addresses);
  assertEquals(plan(resolved).preview.services[0].matchedBy, 'address');
  assertEquals(plan(resolved).relationships.length, 3);
  assertEquals(plan({}).preview.services[0].roots.length, 0);
  for (const values of [[], ['127.0.0.1'], ['172.20.0.2', '203.0.113.1'], ['172.20.0.3']]) {
    assertEquals(plan({ [hostname]: values }).preview.services[0].roots.length, 0);
  }
  const original = plan(resolved).preview.services[0].evidenceIdentity;
  report.containers[0].Networks[0].GlobalIPv6Address = '2001:db8::2';
  const first = plan(resolved).preview.services[0].evidenceIdentity;
  const changed = plan({ [hostname]: ['172.20.0.2', '2001:db8::2'] });
  assertEquals(changed.preview.services[0].matchedBy, 'address');
  assert(first !== changed.preview.services[0].evidenceIdentity);
  assert(original !== first);
});

Deno.test('resolved hostname still requires correct port and unique host listener ownership', () => {
  const { report, endpoints } = fixture();
  endpoints[0].connectionHost = 'edon';
  const addresses = { edon: report.hostAddresses };
  const plan = () => dockerStorage(JSON.stringify(report), endpoints, [], now, {}, true, addresses);
  assertEquals(plan().preview.services[0].matchedBy, 'address');
  endpoints[0].connectionPort = 1234;
  assertEquals(plan().preview.services[0].roots.length, 0);
  report.containers[0].NetworkMode = 'host';
  report.containers[0].listeningPorts = [1234];
  assertEquals(plan().preview.services[0].matchedBy, 'address');
  report.containers[1].NetworkMode = 'host';
  report.containers[1].listeningPorts = [1234];
  assertEquals(plan().preview.services[0].roots.length, 0);
});
