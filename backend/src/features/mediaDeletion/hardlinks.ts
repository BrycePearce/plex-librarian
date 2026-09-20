import type { ArrCleanupFile, ArrPathMapping } from '@plex-librarian/shared/types.ts';

interface NormalizedRemotePath {
  path: string;
  comparison: string;
  separator: '/' | '\\';
}

interface MappedPath {
  path: string;
  root: string;
  arrRoot: NormalizedRemotePath;
}

export interface VerifiedOrphanFile extends ArrCleanupFile {
  hash: string;
  importedPath: string;
  importedRoot: string;
  root: string;
  boundary: string;
  remotePath: string;
  dev: number;
  ino: number;
  nlink?: number;
  rootDevice?: string;
  rootInode?: string;
  importedRootDevice?: string;
  importedRootInode?: string;
  managedFileId?: number;
  managedFileSize?: number;
  managedPath?: string;
  strictTwoLinkProof?: true;
}

export interface PayloadScanBudget {
  remainingEntries: number;
}

export interface AttemptedOrphanFile {
  path: string;
  root: string;
  rootDevice: string;
  rootInode: string;
}

function normalizeLocalAbsolute(path: string): string | null {
  if (!path.startsWith('/') || path.includes('\\')) return null;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

export function normalizeRemoteAbsolute(input: string): NormalizedRemotePath | null {
  const raw = input.trim();
  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    const drive = raw[0]!.toUpperCase();
    const segments = raw.slice(3).split(/[\\/]+/).filter((part) => part && part !== '.');
    if (segments.includes('..')) return null;
    const path = `${drive}:\\${segments.join('\\')}`.replace(/\\$/, '');
    return { path, comparison: path.toLowerCase(), separator: '\\' };
  }
  if (/^(?:\\\\|\/\/)/.test(raw)) {
    const segments = raw.replace(/^[\\/]+/, '').split(/[\\/]+/).filter((part) =>
      part && part !== '.'
    );
    if (segments.length < 2 || segments.includes('..')) return null;
    const path = `\\\\${segments.join('\\')}`;
    return { path, comparison: path.toLowerCase(), separator: '\\' };
  }
  if (!raw.startsWith('/')) return null;
  const segments = raw.split('/').filter((part) => part && part !== '.');
  if (segments.includes('..')) return null;
  const path = `/${segments.join('/')}`;
  return { path, comparison: path, separator: '/' };
}

function remoteWithin(root: NormalizedRemotePath, path: NormalizedRemotePath): boolean {
  return root.separator === path.separator &&
    (path.comparison === root.comparison ||
      path.comparison.startsWith(`${root.comparison}${root.separator}`));
}

export function mapArrPath(
  input: string,
  kind: ArrPathMapping['kind'],
  mappings: readonly ArrPathMapping[],
): MappedPath | null {
  const normalized = normalizeRemoteAbsolute(input);
  if (!normalized) return null;
  const candidates = mappings.flatMap((mapping) => {
    if (mapping.kind !== kind) return [];
    const arrRoot = normalizeRemoteAbsolute(mapping.arrPath);
    const localPath = normalizeLocalAbsolute(mapping.localPath);
    if (!arrRoot || !localPath || !remoteWithin(arrRoot, normalized)) return [];
    return [{ arrRoot, localPath }];
  }).sort((a, b) => b.arrRoot.comparison.length - a.arrRoot.comparison.length);
  const mapping = candidates[0];
  if (!mapping) return null;
  const relative = normalized.path.slice(mapping.arrRoot.path.length)
    .replace(/^[\\/]+/, '').replace(/\\/g, '/');
  return {
    path: relative ? `${mapping.localPath}/${relative}` : mapping.localPath,
    root: mapping.localPath,
    arrRoot: mapping.arrRoot,
  };
}
