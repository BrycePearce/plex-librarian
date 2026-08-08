import type { ArrPathMapping } from '@plex-librarian/shared/types.ts';
import type { SqliteClient } from '../../db/index.ts';
import { normalizeRemoteAbsolute } from './hardlinks.ts';

export interface PlexNamespaceMappingRecord {
  id: number;
  serverId: number;
  libraryKey: string;
  plexPath: string;
  localPath: string;
  caseSensitive: boolean;
  revision: number;
}

export interface PersistedPathNamespaceEvidence {
  plexMappingId: number;
  plexMappingRevision: number;
  plexPath: string;
  localPath: string;
  arrPath: string;
  arrMappingKind: 'library' | 'download';
  arrMappingRoot: string;
  arrLocalRoot: string;
}

export interface PersistedPhysicalIdentityEvidence {
  selectedLocalPath: string;
  retainedLocalPath: string;
  selectedSize: number;
  retainedSize: number;
  selectedDevice: string;
  selectedInode: string;
  retainedDevice: string;
  retainedInode: string;
  selectedParentDevice: string;
  selectedParentInode: string;
  retainedParentDevice: string;
  retainedParentInode: string;
  selectedCanonicalPath: string;
  retainedCanonicalPath: string;
}

function normalizeLocal(input: string): string | null {
  if (!input.startsWith('/') || input.includes('\\')) return null;
  const parts = input.split('/').filter((part) => part && part !== '.');
  if (parts.includes('..')) return null;
  return `/${parts.join('/')}`;
}

function localWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function remoteWithin(path: string, root: string, caseSensitive: boolean): boolean {
  const normalizedPath = normalizeRemoteAbsolute(path);
  const normalizedRoot = normalizeRemoteAbsolute(root);
  if (!normalizedPath || !normalizedRoot || normalizedPath.separator !== normalizedRoot.separator) {
    return false;
  }
  const candidate = caseSensitive ? normalizedPath.path : normalizedPath.comparison;
  const prefix = caseSensitive ? normalizedRoot.path : normalizedRoot.comparison;
  return candidate === prefix || candidate.startsWith(`${prefix}${normalizedRoot.separator}`);
}

export function loadPlexNamespaceMappings(
  client: SqliteClient,
  serverId: number,
  libraryKey: string,
): PlexNamespaceMappingRecord[] {
  const rows = client.prepare(
    `SELECT id, server_id, library_key, plex_path, local_path, case_sensitive, revision
     FROM plex_path_mappings WHERE server_id = ? AND library_key = ? ORDER BY id`,
  ).values(serverId, libraryKey);
  return rows.map((row) => ({
    id: Number(row[0]),
    serverId: Number(row[1]),
    libraryKey: String(row[2]),
    plexPath: String(row[3]),
    localPath: String(row[4]),
    caseSensitive: Number(row[5]) === 1,
    revision: Number(row[6]),
  }));
}

export function resolvePlexToLocal(
  plexPath: string,
  mappings: readonly PlexNamespaceMappingRecord[],
): { path: string; mapping: PlexNamespaceMappingRecord } | null {
  const candidates = mappings.flatMap((mapping) => {
    if (!remoteWithin(plexPath, mapping.plexPath, mapping.caseSensitive)) return [];
    const source = normalizeRemoteAbsolute(mapping.plexPath)!;
    const candidate = normalizeRemoteAbsolute(plexPath)!;
    const relative = candidate.path.slice(source.path.length).replace(/^[\\/]+/, '')
      .replaceAll('\\', '/');
    const local = normalizeLocal(relative ? `${mapping.localPath}/${relative}` : mapping.localPath);
    return local ? [{ path: local, mapping }] : [];
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

export function resolveLocalToArr(
  localPath: string,
  mappings: readonly ArrPathMapping[],
): {
  arrPath: string;
  kind: ArrPathMapping['kind'];
  arrRoot: string;
  localRoot: string;
} | null {
  const local = normalizeLocal(localPath);
  if (!local) return null;
  const candidates = new Map<string, {
    arrPath: string;
    kind: ArrPathMapping['kind'];
    arrRoot: string;
    localRoot: string;
  }>();
  for (const mapping of mappings) {
    const localRoot = normalizeLocal(mapping.localPath);
    const arrRoot = normalizeRemoteAbsolute(mapping.arrPath);
    if (!localRoot || !arrRoot || !localWithin(local, localRoot)) continue;
    const relative = local.slice(localRoot.length).replace(/^\/+/, '');
    const arrPath = relative
      ? `${arrRoot.path}${arrRoot.separator}${relative.replaceAll('/', arrRoot.separator)}`
      : arrRoot.path;
    const normalized = normalizeRemoteAbsolute(arrPath);
    if (!normalized) continue;
    candidates.set(`${mapping.kind}:${normalized.comparison}`, {
      arrPath: normalized.path,
      kind: mapping.kind,
      arrRoot: arrRoot.path,
      localRoot,
    });
  }
  return candidates.size === 1 ? [...candidates.values()][0]! : null;
}

export function resolvePathNamespace(
  plexPath: string,
  plexMappings: readonly PlexNamespaceMappingRecord[],
  arrMappings: readonly ArrPathMapping[],
): PersistedPathNamespaceEvidence | null {
  const local = resolvePlexToLocal(plexPath, plexMappings);
  if (!local) return null;
  const arr = resolveLocalToArr(local.path, arrMappings);
  if (!arr) return null;
  return {
    plexMappingId: local.mapping.id,
    plexMappingRevision: local.mapping.revision,
    plexPath,
    localPath: local.path,
    arrPath: arr.arrPath,
    arrMappingKind: arr.kind,
    arrMappingRoot: arr.arrRoot,
    arrLocalRoot: arr.localRoot,
  };
}

async function lstatChain(path: string): Promise<Deno.FileInfo> {
  const windowsDrive = /^([a-zA-Z]:)[\\/]/.exec(path)?.[1];
  const separator = windowsDrive ? '\\' : '/';
  let current = windowsDrive ? `${windowsDrive}\\` : '';
  const segments = path.replace(/^[a-zA-Z]:[\\/]/, '').split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    current = current
      ? `${current.replace(/[\\/]$/, '')}${separator}${segment}`
      : `${separator}${segment}`;
    const info = await Deno.lstat(current);
    if (info.isSymlink) {
      throw new Error(`Symbolic links are unavailable for path adoption: ${current}`);
    }
  }
  return await Deno.lstat(path);
}

function comparableLocalPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return Deno.build.os === 'windows' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

async function linuxMountIdentity(path: string): Promise<string | null> {
  if (Deno.build.os !== 'linux') return null;
  let mountInfo: string;
  try {
    mountInfo = await Deno.readTextFile('/proc/self/mountinfo');
  } catch {
    return null;
  }
  const candidate = comparableLocalPath(path);
  let best: { path: string; identity: string } | null = null;
  for (const line of mountInfo.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 6) continue;
    const mountPath = fields[4]!
      .replaceAll('\\040', ' ')
      .replaceAll('\\011', '\t')
      .replaceAll('\\134', '\\');
    const comparableMount = comparableLocalPath(mountPath);
    if (
      candidate !== comparableMount &&
      !candidate.startsWith(`${comparableMount}/`)
    ) continue;
    if (!best || comparableMount.length > best.path.length) {
      best = { path: comparableMount, identity: `${fields[0]}:${fields[3]}:${mountPath}` };
    }
  }
  return best?.identity ?? null;
}

function parent(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function identity(info: Deno.FileInfo, description: string): { dev: string; ino: string } {
  if (info.dev === null || info.ino === null) {
    throw new Error(`${description} has no stable filesystem identity on this platform`);
  }
  return { dev: String(info.dev), ino: String(info.ino) };
}

export async function provePhysicalDeletionIndependence(
  selectedLocalPath: string,
  retainedLocalPath: string,
  selectedExpectedSize: number,
  retainedExpectedSize: number,
): Promise<PersistedPhysicalIdentityEvidence> {
  if (comparableLocalPath(selectedLocalPath) === comparableLocalPath(retainedLocalPath)) {
    throw new Error('The selected and retained versions resolve to one local pathname');
  }
  const [selected, retained, selectedParent, retainedParent, selectedCanonical, retainedCanonical] =
    await Promise.all([
      lstatChain(selectedLocalPath),
      lstatChain(retainedLocalPath),
      lstatChain(parent(selectedLocalPath)),
      lstatChain(parent(retainedLocalPath)),
      Deno.realPath(selectedLocalPath),
      Deno.realPath(retainedLocalPath),
    ]);
  if (!selected.isFile || !retained.isFile) {
    throw new Error('The selected and retained mapped paths must both be files');
  }
  if (selected.size !== selectedExpectedSize || retained.size !== retainedExpectedSize) {
    throw new Error('Mapped local file size no longer matches Plex');
  }
  if (selectedCanonical === retainedCanonical) {
    throw new Error('The selected and retained paths are aliases of one directory entry');
  }
  const selectedIdentity = identity(selected, 'Selected file');
  const retainedIdentity = identity(retained, 'Retained file');
  const selectedParentIdentity = identity(selectedParent, 'Selected parent');
  const retainedParentIdentity = identity(retainedParent, 'Retained parent');
  const sameParent = selectedParentIdentity.dev === retainedParentIdentity.dev &&
    selectedParentIdentity.ino === retainedParentIdentity.ino;
  const selectedName = selectedCanonical.split('/').at(-1)?.toLocaleLowerCase('en-US');
  const retainedName = retainedCanonical.split('/').at(-1)?.toLocaleLowerCase('en-US');
  if (sameParent && selectedName === retainedName) {
    throw new Error('The selected and retained paths may be case or mount aliases');
  }
  if (
    selectedIdentity.dev === retainedIdentity.dev &&
    selectedIdentity.ino === retainedIdentity.ino
  ) {
    if (Deno.build.os === 'linux') {
      const [selectedMount, retainedMount] = await Promise.all([
        linuxMountIdentity(selectedCanonical),
        linuxMountIdentity(retainedCanonical),
      ]);
      if (selectedMount === null || retainedMount === null) {
        if (!sameParent) {
          throw new Error('The platform cannot distinguish hardlinks from namespace aliases');
        }
      } else if (selectedMount !== retainedMount) {
        throw new Error('The selected and retained paths are aliases through different mounts');
      }
    }
  }
  return {
    selectedLocalPath,
    retainedLocalPath,
    selectedSize: selected.size,
    retainedSize: retained.size,
    selectedDevice: selectedIdentity.dev,
    selectedInode: selectedIdentity.ino,
    retainedDevice: retainedIdentity.dev,
    retainedInode: retainedIdentity.ino,
    selectedParentDevice: selectedParentIdentity.dev,
    selectedParentInode: selectedParentIdentity.ino,
    retainedParentDevice: retainedParentIdentity.dev,
    retainedParentInode: retainedParentIdentity.ino,
    selectedCanonicalPath: selectedCanonical,
    retainedCanonicalPath: retainedCanonical,
  };
}
