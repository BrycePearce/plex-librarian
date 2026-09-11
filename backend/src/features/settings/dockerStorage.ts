import { createHash } from 'node:crypto';
import type { DiscoveryAddresses } from './discoveryAddresses.ts';
import {
  type DockerStoragePreview,
  type ProposedServiceRoot,
  type ServicePathRoot,
  type ServiceStorageEndpoint,
  storageContains,
  storagePath,
} from '../../../../shared/serviceStorage.ts';

interface Mount {
  Type: string;
  Source: string;
  Destination: string;
  Name?: string;
  Driver?: string;
}
interface Container {
  Id: string;
  Name: string;
  State: { Running: boolean };
  Mounts: Mount[];
  volumeSubpaths: Array<{ Destination: string; Subpath: string }>;
  tmpfsTargets: string[];
  nonRecursiveBindTargets: string[];
  NetworkMode: string;
  Networks: Array<
    { Name: string; IPAddress: string; GlobalIPv6Address: string; Aliases: string[] }
  >;
  Ports: Array<{ containerPort: number; hostIp: string; hostPort: number }>;
  listeningPorts?: number[];
  declaredPorts?: number[];
}
interface Report {
  version: number;
  daemonId: string;
  generatedAt: string;
  hostAddresses: string[];
  containers: Container[];
  volumes?: Array<{ Name: string; Driver: string; OptionsCount: number }>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bad = () =>
  new Error(
    'Invalid Docker mount report. Run the supplied collector again; do not paste docker inspect or credentials.',
  );
function string(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' || value.length > 4096 ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  ) throw bad();
}
export function parseDockerReport(text: string, now = Date.now()): Report {
  if (typeof text !== 'string' || text.length > 2_000_000) throw bad();
  let report: Report;
  try {
    report = JSON.parse(text) as Report;
  } catch {
    throw bad();
  }
  if (!report || report.version !== 3) throw bad();
  string(report.daemonId);
  string(report.generatedAt);
  const generated = Date.parse(report.generatedAt);
  if (
    !report.daemonId || !Number.isFinite(generated) || generated > now + 300_000 ||
    now - generated > 86_400_000
  ) {
    throw new Error(
      'Docker report is expired or its clock is incorrect. Collect a new report (valid for 24 hours).',
    );
  }
  if (
    !Array.isArray(report.hostAddresses) || report.hostAddresses.length > 100 ||
    !Array.isArray(report.containers) || report.containers.length > 500
  ) throw bad();
  report.hostAddresses.forEach(string);
  if (report.volumes !== undefined) {
    if (!Array.isArray(report.volumes) || report.volumes.length > 500) throw bad();
    for (const v of report.volumes) {
      string(v.Name);
      string(v.Driver);
      if (!Number.isInteger(v.OptionsCount) || v.OptionsCount < 0) throw bad();
    }
  }
  const ids = new Set<string>();
  for (const c of report.containers) {
    string(c.Id);
    string(c.Name);
    string(c.NetworkMode);
    if (!c.Id || ids.has(c.Id) || typeof c.State?.Running !== 'boolean') throw bad();
    ids.add(c.Id);
    if (
      !Array.isArray(c.Mounts) || c.Mounts.length > 200 || !Array.isArray(c.Networks) ||
      c.Networks.length > 100 || !Array.isArray(c.Ports) || c.Ports.length > 200
    ) throw bad();
    if (
      !Array.isArray(c.volumeSubpaths) || c.volumeSubpaths.length > 200 ||
      !Array.isArray(c.tmpfsTargets) || c.tmpfsTargets.length > 200
    ) throw bad();
    for (const target of c.tmpfsTargets) {
      string(target);
      storagePath(target);
    }
    if (!Array.isArray(c.nonRecursiveBindTargets) || c.nonRecursiveBindTargets.length > 200) {
      throw bad();
    }
    for (const target of c.nonRecursiveBindTargets) {
      string(target);
      storagePath(target);
    }
    for (const entry of c.volumeSubpaths) {
      if (!entry || typeof entry !== 'object') throw bad();
      string(entry.Destination);
      storagePath(entry.Destination);
      string(entry.Subpath);
      if (
        !entry.Subpath || entry.Subpath.startsWith('/') || entry.Subpath.includes('\\') ||
        entry.Subpath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      ) throw bad();
    }
    for (const m of c.Mounts) {
      string(m.Type);
      string(m.Source);
      string(m.Destination);
      storagePath(m.Destination);
      if (m.Name !== undefined) string(m.Name);
      if (m.Driver !== undefined) string(m.Driver);
    }
    for (const n of c.Networks) {
      string(n.Name);
      string(n.IPAddress);
      string(n.GlobalIPv6Address);
      if (!Array.isArray(n.Aliases) || n.Aliases.length > 100) throw bad();
      n.Aliases.forEach(string);
    }
    for (const p of c.Ports) {
      if (typeof p.containerPort === 'string' && /^\d+\/tcp$/.test(p.containerPort)) {
        p.containerPort = Number((p.containerPort as string).split('/')[0]);
      }
      if (typeof p.hostPort === 'string' && /^\d+$/.test(p.hostPort)) {
        p.hostPort = Number(p.hostPort);
      }
      string(p.hostIp);
      if (![p.containerPort, p.hostPort].every((v) => Number.isInteger(v) && v > 0 && v <= 65535)) {
        throw bad();
      }
    }
    if (c.declaredPorts !== undefined) {
      if (!Array.isArray(c.declaredPorts) || c.declaredPorts.length > 200) throw bad();
      c.declaredPorts = c.declaredPorts.map((value) =>
        typeof value === 'string' && /^\d+\/tcp$/.test(value)
          ? Number((value as string).split('/')[0])
          : value
      );
      if (c.declaredPorts.some((v) => !Number.isInteger(v) || v < 1 || v > 65535)) throw bad();
    }
    if (
      c.listeningPorts !== undefined &&
      (!Array.isArray(c.listeningPorts) || c.listeningPorts.length > 200 ||
        c.listeningPorts.some((v) => !Number.isInteger(v) || v < 1 || v > 65535))
    ) throw bad();
  }
  // Project the allowlist even when callers supplied extra inspect fields. Only
  // this credential-free shape may cross the helper transport boundary.
  return {
    version: 3,
    daemonId: report.daemonId,
    generatedAt: report.generatedAt,
    hostAddresses: report.hostAddresses,
    volumes: report.volumes?.map(({ Name, Driver, OptionsCount }) => ({
      Name,
      Driver,
      OptionsCount,
    })),
    containers: report.containers.map((c) => ({
      Id: c.Id,
      Name: c.Name,
      State: { Running: c.State.Running },
      Mounts: c.Mounts.map(({ Type, Source, Destination, Name, Driver }) => ({
        Type,
        Source,
        Destination,
        Name,
        Driver,
      })),
      volumeSubpaths: c.volumeSubpaths.map(({ Destination, Subpath }) => ({
        Destination,
        Subpath,
      })),
      tmpfsTargets: c.tmpfsTargets,
      nonRecursiveBindTargets: c.nonRecursiveBindTargets,
      NetworkMode: c.NetworkMode,
      Networks: c.Networks.map(({ Name, IPAddress, GlobalIPv6Address, Aliases }) => ({
        Name,
        IPAddress,
        GlobalIPv6Address,
        Aliases,
      })),
      Ports: c.Ports.map(({ containerPort, hostIp, hostPort }) => ({
        containerPort,
        hostIp,
        hostPort,
      })),
      listeningPorts: c.listeningPorts,
      declaredPorts: c.declaredPorts,
    })),
  };
}
const host = (s: string) => s.toLowerCase().replace(/^\[|\]$/g, '');
function matches(endpoint: ServiceStorageEndpoint, c: Container, report: Report): boolean {
  if (!endpoint.connectionHost || !endpoint.connectionPort || !c.State.Running) return false;
  const h = host(endpoint.connectionHost), port = endpoint.connectionPort;
  if (
    ['localhost', '127.0.0.1', '::1'].includes(h) ||
    (endpoint.connectionPath && endpoint.connectionPath !== '/')
  ) return false;
  if (c.NetworkMode === 'host') {
    return report.hostAddresses.some((v) => host(v) === h) && !!c.listeningPorts?.includes(port);
  }
  const direct = [
    ...c.Networks.flatMap((n) => [n.IPAddress, n.GlobalIPv6Address, ...n.Aliases]),
  ].filter(Boolean).some((v) => host(v) === h);
  if (
    direct && c.NetworkMode !== 'host' &&
    (c.Ports.some((p) => p.containerPort === port) || c.declaredPorts?.includes(port))
  ) {
    return true;
  }
  return report.hostAddresses.some((v) => host(v) === h) &&
    c.Ports.some((p) =>
      p.hostPort === port && (['0.0.0.0', '::', ''].includes(p.hostIp) || host(p.hostIp) === h)
    );
}
function translated(root: string, c: Container, report: Report): string {
  if (
    c.nonRecursiveBindTargets.some((target) =>
      storageContains(target, root) || storageContains(root, target)
    )
  ) {
    throw new Error(
      'This media root uses a non-recursive Docker bind mount. Automatic setup cannot establish its storage relationship.',
    );
  }
  if (
    c.volumeSubpaths.some((entry) =>
      storageContains(entry.Destination, root) || storageContains(root, entry.Destination)
    )
  ) {
    throw new Error(
      'This media root uses a Docker volume subpath. Automatic setup does not support volume subpaths.',
    );
  }
  if (
    c.tmpfsTargets.some((target) => storageContains(target, root) || storageContains(root, target))
  ) {
    throw new Error(
      'A Docker tmpfs mount covers or overrides this media root. Automatic setup cannot represent that layout.',
    );
  }
  const mounts = c.Mounts.filter((m) => storageContains(m.Destination, root));
  mounts.sort((a, b) => b.Destination.length - a.Destination.length);
  const mount = mounts[0];
  if (
    !mount ||
    mounts.filter((m) => storagePath(m.Destination) === storagePath(mount.Destination)).length !== 1
  ) throw new Error('No unambiguous Docker mount covers this media root.');
  if (
    c.Mounts.some((m) =>
      storagePath(m.Destination) !== storagePath(mount.Destination) &&
      storageContains(root, m.Destination)
    )
  ) {
    throw new Error(
      'A nested Docker mount overrides this media root. Automatic setup cannot represent that layout.',
    );
  }
  if (
    mount.Type !== 'bind' &&
    !(mount.Type === 'volume' && mount.Name &&
      report.volumes?.filter((v) =>
          v.Name === mount.Name && v.Driver === 'local' && v.OptionsCount === 0
        ).length === 1)
  ) {
    throw new Error(
      'Only bind mounts and ordinary local Docker volumes support automatic setup.',
    );
  }
  const source = storagePath(mount.Source);
  if (/^\/(host_mnt|run\/desktop|mnt\/(host|wsl)|Users|[a-zA-Z])(?:\/|$)/.test(source)) {
    throw new Error(
      'Docker Desktop and translated host filesystems are unsupported. Collect from a native Linux Docker host.',
    );
  }
  if (!source.startsWith('/') || source === '/') {
    throw new Error('This mount source is not a supported Linux media directory.');
  }
  // Docker does not expose host symlink equivalence. Keep host paths literal; never infer aliases.
  const suffix = root.slice(storagePath(mount.Destination).length).replace(/^\//, '');
  return storagePath(`/docker/${digest(report.daemonId).slice(0, 24)}${source}/${suffix}`);
}

/** Imported declared configuration, not proof of physical files or a live Docker connection. */
export function dockerStorage(
  text: string,
  endpoints: ServiceStorageEndpoint[],
  saved: ServicePathRoot[],
  now = Date.now(),
  selections: Record<string, string> = {},
  allowPartial = false,
  addresses: DiscoveryAddresses = {},
): { preview: DockerStoragePreview; relationships: ProposedServiceRoot[] } {
  const report = parseDockerReport(text, now);
  if (
    !selections || typeof selections !== 'object' || Array.isArray(selections) ||
    Object.entries(selections).some(([key, value]) =>
      !endpoints.some((e) => e.key === key) || typeof value !== 'string' ||
      !report.containers.some((c) => c.Id === value && c.State.Running)
    )
  ) throw bad();
  const relationships: ProposedServiceRoot[] = [];
  const services: DockerStoragePreview['services'] = [];
  for (const endpoint of endpoints.filter((e) => e.supportedMedia !== false)) {
    const service: DockerStoragePreview['services'][number] = {
      serviceKey: endpoint.key,
      name: endpoint.name,
      roots: [],
    };
    services.push(service);
    try {
      if (!endpoint.connectionTestedAt || endpoint.discoveryError || !endpoint.roots.length) {
        throw new Error('Test this connection and discover its media roots first.');
      }
      const candidates = selections[endpoint.key]
        ? report.containers.filter((c) => c.Id === selections[endpoint.key])
        : report.containers.filter((c) => {
          const resolved = addresses[host(endpoint.connectionHost ?? '')];
          // Every returned address must identify this same container and port.
          // A mixed local/remote DNS answer is not evidence for a local mount.
          return resolved === undefined
            ? matches(endpoint, c, report)
            : resolved.length > 0 && resolved.every((connectionHost) =>
              matches({ ...endpoint, connectionHost }, c, report)
            );
        });
      if (candidates.length !== 1) {
        service.candidates = report.containers.filter((c) => c.State.Running).map((c) => ({
          id: c.Id,
          name: c.Name.replace(/^\//, ''),
        }));
        throw new Error(
          'Choose the container that runs this connected service. Its address could not be matched automatically.',
        );
      }
      service.matchedBy = selections[endpoint.key] ? 'selection' : 'address';
      const container = candidates[0];
      service.evidenceIdentity = dockerSemanticRevision({
        daemonId: report.daemonId,
        container,
        addresses: addresses[host(endpoint.connectionHost ?? '')],
      });
      service.containerName = container.Name.replace(/^\//, '');
      const paths = [...new Set(endpoint.roots.map(storagePath))];
      for (
        const root of paths.filter((p) =>
          !paths.some((other) => other !== p && storageContains(other, p))
        )
      ) {
        const storageRoot = translated(root, container, report);
        service.roots.push({
          serviceRoot: root,
          storageRoot,
          hostPath: storageRoot.replace(/^\/docker\/[^/]+/, ''),
        });
      }
      if (
        service.roots.some((a, i) =>
          service.roots.slice(i + 1).some((b) =>
            storageContains(a.storageRoot, b.storageRoot, false) ||
            storageContains(b.storageRoot, a.storageRoot, false)
          )
        )
      ) throw new Error('Multiple media roots alias or overlap on the Docker host.');
      relationships.push(
        ...service.roots.map((r) => ({
          ...r,
          serviceKey: endpoint.key,
          configurationIdentity: endpoint.configurationIdentity,
          caseSensitive: true,
          hasAliases: false,
        })),
      );
    } catch (error) {
      service.roots = [];
      service.reason = error instanceof Error ? error.message : 'Docker mapping unavailable.';
    }
  }
  // Partial setup must not imply that unverified download owners are safe.
  const sourceFamilies = new Set(
    relationships.map((r) => /^\/docker\/[^/]+\/mnt\/([^/]+)(?:\/|$)/.exec(r.storageRoot)?.[1])
      .filter(Boolean),
  );
  if (sourceFamilies.size > 1 && (sourceFamilies.has('user') || sourceFamilies.has('user0'))) {
    throw new Error(
      'These media mounts mix Unraid user-share and disk/pool paths. Their storage can alias; use one consistent host path namespace before importing.',
    );
  }
  if (
    !services.some((s) => s.serviceKey.startsWith('plex:')) ||
    services.some((s) => s.reason && !s.serviceKey.startsWith('arr:'))
  ) {
    return {
      preview: {
        status: 'unavailable',
        replacementRequired: false,
        services,
        reason:
          'Some required services could not be matched safely. No relationships will be changed.',
      },
      relationships: allowPartial ? relationships : [],
    };
  }
  const keys = new Set(relationships.map((r) => r.serviceKey));
  const existing = saved.filter((r) => keys.has(r.serviceKey));
  const invalidatedServices = [
    ...new Set(saved.filter((r) => !keys.has(r.serviceKey)).map((r) => r.serviceKey)),
  ].map((serviceKey) => ({
    serviceKey,
    name: endpoints.find((e) => e.key === serviceKey)?.name ?? serviceKey,
  }));
  const shape = (r: ProposedServiceRoot) =>
    JSON.stringify([
      r.serviceKey,
      r.configurationIdentity,
      r.serviceRoot,
      r.storageRoot,
      r.caseSensitive,
      r.hasAliases,
    ]);
  const ready = !invalidatedServices.length && existing.length === relationships.length &&
    existing.every((r) => relationships.some((p) => shape(r) === shape(p)));
  const fingerprint = digest({
    report,
    selections,
    endpoints: endpoints.map(({ connectionTestedAt: _tested, ...e }) => e),
    saved,
    relationships,
  });
  return {
    preview: {
      status: ready ? 'ready' : 'confirmation_required',
      replacementRequired: saved.length > 0 && !ready,
      invalidatedServices,
      fingerprint,
      services,
    },
    relationships,
  };
}

/** Collection ordering and timestamps are not mapping changes. */
export function dockerSemanticRevision(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([key]) => key !== 'generatedAt').sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return v;
  };
  return digest(canonical(value));
}
