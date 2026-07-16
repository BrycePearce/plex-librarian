import type {
  ArrCleanupFile,
  ArrCleanupRetainedPath,
  ArrCleanupSource,
  ArrPathMapping,
} from '@plex-librarian/shared/types.ts';
import type { ArrTorrentAssociation } from '../../integrations/arr/client.ts';
import { pathMappingRootsAreDisjoint } from './mappings.ts';

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
}

export interface OrphanVerification {
  source: ArrCleanupSource;
  file: VerifiedOrphanFile | null;
}

export interface PayloadScanLimits {
  maxEntries: number;
  maxDepth: number;
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

export const DEFAULT_PAYLOAD_SCAN_LIMITS: PayloadScanLimits = {
  maxEntries: 5_000,
  maxDepth: 12,
};

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

function joinRemote(root: string, relative: string): string | null {
  const normalizedRoot = normalizeRemoteAbsolute(root);
  if (!normalizedRoot || normalizeRemoteAbsolute(relative)) return null;
  const segments = relative.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return `${normalizedRoot.path}${normalizedRoot.separator}${
    segments.join(normalizedRoot.separator)
  }`;
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

function remoteForMappedLocal(mapped: MappedPath, localPath: string): string | null {
  if (!isWithin(mapped.root, localPath)) return null;
  const relative = localPath.slice(mapped.root.length).replace(/^\/+/, '');
  return relative
    ? `${mapped.arrRoot.path}${mapped.arrRoot.separator}${
      relative.replaceAll('/', mapped.arrRoot.separator)
    }`
    : mapped.arrRoot.path;
}

function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

async function lstatWithoutSymlinks(path: string): Promise<Deno.FileInfo> {
  let current = '';
  for (const segment of path.split('/').filter(Boolean)) {
    current += `/${segment}`;
    const info = await Deno.lstat(current);
    if (info.isSymlink) throw new Error('A symbolic link appears in the path');
  }
  return await Deno.lstat(path);
}

export async function completedOrphanFileAttempt(
  attempt: AttemptedOrphanFile,
  configuredDownloadRoots: ReadonlySet<string>,
): Promise<boolean> {
  if (!isWithin(attempt.root, attempt.path) || attempt.path === attempt.root) {
    throw new Error('Stored orphan cleanup path is outside its configured root');
  }
  if (!configuredDownloadRoots.has(attempt.root)) {
    throw new Error('Stored orphan cleanup root is no longer configured for this Arr connection');
  }
  const rootInfo = await lstatWithoutSymlinks(attempt.root);
  if (
    !rootInfo.isDirectory || rootInfo.dev === null || rootInfo.ino === null ||
    String(rootInfo.dev) !== attempt.rootDevice || String(rootInfo.ino) !== attempt.rootInode
  ) throw new Error('Configured orphan cleanup root mount has changed since the delete attempt');
  try {
    await lstatWithoutSymlinks(attempt.path);
    return false;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
}

export async function orphanRootIdentity(
  root: string,
): Promise<{ rootDevice: string; rootInode: string }> {
  const info = await lstatWithoutSymlinks(root);
  if (!info.isDirectory || info.dev === null || info.ino === null) {
    throw new Error('Configured orphan cleanup root has no stable filesystem identity');
  }
  return { rootDevice: String(info.dev), rootInode: String(info.ino) };
}

async function canonicalWithin(root: string, path: string): Promise<boolean> {
  const [canonicalRoot, canonicalPath] = await Promise.all([
    Deno.realPath(root),
    Deno.realPath(path),
  ]);
  return isWithin(canonicalRoot.replace(/\/+$/, ''), canonicalPath);
}

function parent(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

async function pathsMayAliasSameDirectoryEntry(left: string, right: string): Promise<boolean> {
  const [leftParent, rightParent] = await Promise.all([
    lstatWithoutSymlinks(parent(left)),
    lstatWithoutSymlinks(parent(right)),
  ]);
  // If both paths resolve through the same underlying directory, filename text is
  // not enough to prove they are distinct entries. Case-insensitive CIFS/NTFS-backed
  // mounts can resolve movie.mkv and Movie.mkv to the same entry, and bind aliases can
  // expose that entry through different configured roots. Reject the whole ambiguous
  // case, including legitimate same-directory hardlinks, rather than risk unlinking
  // the Arr-managed evidence file.
  return leftParent.isDirectory && rightParent.isDirectory && leftParent.dev !== null &&
    leftParent.ino !== null && leftParent.dev === rightParent.dev &&
    leftParent.ino === rightParent.ino;
}

async function payloadBoundary(
  association: ArrTorrentAssociation,
  source: MappedPath,
): Promise<string> {
  const mappedPayload = association.payloadPath
    ? mapArrPath(association.payloadPath, 'download', [{
      kind: 'download',
      arrPath: source.arrRoot.path,
      localPath: source.root,
    }])
    : null;
  let boundary = mappedPayload?.path ?? parent(source.path);
  if (boundary === source.path) boundary = parent(source.path);
  const info = await Deno.lstat(boundary).catch(() => null);
  if (!info || info.isFile) boundary = parent(source.path);
  if (
    boundary === source.root || !isWithin(source.root, boundary) || !isWithin(boundary, source.path)
  ) {
    boundary = parent(source.path);
  }
  return boundary;
}

function unavailable(
  instanceName: string,
  association: ArrTorrentAssociation,
  reason: string,
  localPath?: string,
): OrphanVerification {
  return {
    source: {
      instanceName,
      hash: association.hash,
      path: association.sourcePath ?? '',
      importedPath: association.importedPath,
      verification: 'unverified',
      ...(localPath ? { localPath } : {}),
      reason,
    },
    file: null,
  };
}

async function verifiedFile(
  hash: string,
  remotePath: string,
  source: MappedPath,
  imported: MappedPath,
  boundary: string,
): Promise<VerifiedOrphanFile | null> {
  // The library-side path is deletion evidence, never a deletion target. Keep this
  // invariant in the shared verifier so every current and future caller gets it.
  if (
    source.path === imported.path ||
    await pathsMayAliasSameDirectoryEntry(source.path, imported.path)
  ) {
    return null;
  }
  const [sourceInfo, importedInfo, sourceContained, importedContained] = await Promise.all([
    lstatWithoutSymlinks(source.path),
    lstatWithoutSymlinks(imported.path),
    canonicalWithin(source.root, source.path),
    canonicalWithin(imported.root, imported.path),
  ]);
  if (
    !sourceContained || !importedContained || !sourceInfo.isFile || !importedInfo.isFile ||
    sourceInfo.dev === null || sourceInfo.ino === null || importedInfo.dev === null ||
    importedInfo.ino === null || sourceInfo.dev !== importedInfo.dev ||
    sourceInfo.ino !== importedInfo.ino || sourceInfo.size !== importedInfo.size ||
    sourceInfo.nlink === null || sourceInfo.nlink < 2
  ) return null;
  return {
    hash,
    path: source.path,
    importedPath: imported.path,
    importedRoot: imported.root,
    root: source.root,
    boundary,
    remotePath,
    size: sourceInfo.size,
    method: 'hardlink',
    dev: sourceInfo.dev,
    ino: sourceInfo.ino,
  };
}

export async function verifyOrphanHardlink(
  instanceName: string,
  association: ArrTorrentAssociation,
  mappings: readonly ArrPathMapping[],
  currentManagedPaths: readonly string[],
): Promise<OrphanVerification | null> {
  if (!association.sourcePath) return null;
  if (!pathMappingRootsAreDisjoint(mappings)) {
    return unavailable(
      instanceName,
      association,
      'Library and download path mappings overlap',
    );
  }
  if (!association.importedPath) {
    return unavailable(instanceName, association, 'Arr history has no imported file path');
  }
  const importedRemote = normalizeRemoteAbsolute(association.importedPath);
  const isCurrentlyManaged = importedRemote !== null && currentManagedPaths.some((path) => {
    const current = normalizeRemoteAbsolute(path);
    return current?.separator === importedRemote.separator &&
      current.comparison === importedRemote.comparison;
  });
  if (!isCurrentlyManaged) {
    return unavailable(
      instanceName,
      association,
      'The historical imported file is not currently managed by Arr',
    );
  }
  const source = mapArrPath(association.sourcePath, 'download', mappings);
  if (!source) {
    return unavailable(instanceName, association, 'No download path mapping covers this path');
  }
  const imported = mapArrPath(association.importedPath, 'library', mappings);
  if (!imported) {
    return unavailable(
      instanceName,
      association,
      'No library path mapping covers the imported file',
      source.path,
    );
  }
  if (source.path === source.root) {
    return unavailable(
      instanceName,
      association,
      'The source resolves to the cleanup root',
      source.path,
    );
  }
  if (source.path === imported.path) {
    return unavailable(
      instanceName,
      association,
      'Source and imported paths resolve to the same file name',
      source.path,
    );
  }

  try {
    const boundary = await payloadBoundary(association, source);
    const file = await verifiedFile(
      association.hash,
      association.sourcePath,
      source,
      imported,
      boundary,
    );
    if (!file) {
      return unavailable(
        instanceName,
        association,
        'Source is not the same hardlinked file',
        source.path,
      );
    }
    return {
      source: {
        instanceName,
        hash: association.hash,
        path: association.sourcePath,
        importedPath: association.importedPath,
        localPath: source.path,
        verification: 'hardlink',
      },
      file,
    };
  } catch (error) {
    const reason = error instanceof Deno.errors.NotFound
      ? 'Source or imported file is not mounted or no longer exists'
      : error instanceof Deno.errors.PermissionDenied
      ? 'Plex Librarian cannot read both mapped paths'
      : error instanceof Error
      ? error.message
      : 'Filesystem verification failed';
    return unavailable(instanceName, association, reason, source.path);
  }
}

export async function verifyTrackedHardlinks(
  titlePath: string | null,
  relativePaths: readonly string[],
  association: ArrTorrentAssociation,
  mappings: readonly ArrPathMapping[],
): Promise<VerifiedOrphanFile[]> {
  if (
    !titlePath || !association.sourcePath || !association.payloadPath ||
    relativePaths.length === 0 || !pathMappingRootsAreDisjoint(mappings)
  ) return [];
  const source = mapArrPath(association.sourcePath, 'download', mappings);
  if (!source) return [];
  const payload = mapArrPath(association.payloadPath, 'download', mappings);
  if (
    !payload || payload.root !== source.root || payload.path === payload.root ||
    payload.path === source.path || !isWithin(payload.path, source.path)
  ) return [];
  const boundary = payload.path;
  try {
    const boundaryInfo = await lstatWithoutSymlinks(boundary);
    if (!boundaryInfo.isDirectory || !(await canonicalWithin(source.root, boundary))) return [];
    const verified: VerifiedOrphanFile[] = [];
    for (const relativePath of relativePaths) {
      const libraryRemote = joinRemote(titlePath, relativePath);
      if (!libraryRemote) continue;
      const imported = mapArrPath(libraryRemote, 'library', mappings);
      if (!imported) continue;
      const downloadRemote = joinRemote(association.payloadPath, relativePath);
      if (!downloadRemote) continue;
      const candidate = mapArrPath(downloadRemote, 'download', mappings);
      if (
        !candidate || candidate.root !== source.root || candidate.path === candidate.root ||
        !isWithin(boundary, candidate.path)
      ) continue;
      const remotePath = remoteForMappedLocal(candidate, candidate.path);
      if (!remotePath) continue;
      const file = await verifiedFile(
        association.hash,
        remotePath,
        candidate,
        imported,
        boundary,
      ).catch(() => null);
      if (file) verified.push(file);
    }
    return verified;
  } catch {
    return [];
  }
}

export async function deleteVerifiedOrphanFile(file: VerifiedOrphanFile): Promise<void> {
  if (file.path === file.importedPath) {
    throw new Error('Refusing to unlink the Arr-managed evidence file');
  }
  const sourceInfo = await lstatWithoutSymlinks(file.path);
  const importedInfo = await lstatWithoutSymlinks(file.importedPath);
  if (
    !sourceInfo.isFile || !importedInfo.isFile || sourceInfo.dev !== file.dev ||
    sourceInfo.ino !== file.ino || importedInfo.dev !== file.dev || importedInfo.ino !== file.ino ||
    sourceInfo.size !== importedInfo.size || sourceInfo.nlink === null || sourceInfo.nlink < 2 ||
    !(await canonicalWithin(file.root, file.path)) ||
    !(await canonicalWithin(file.importedRoot, file.importedPath)) ||
    !isWithin(file.boundary, file.path)
  ) throw new Error('Hardlink verification changed since preview');
  if (await pathsMayAliasSameDirectoryEntry(file.path, file.importedPath)) {
    throw new Error('Refusing to unlink the Arr-managed evidence file');
  }

  // Keep the final path resolution immediately adjacent to unlink. Deno does not expose
  // unlinkat/openat-style descriptor-relative deletion, so re-check the exact inode after
  // every other awaited guard and fail closed if another process changed the entry.
  const finalSourceInfo = await lstatWithoutSymlinks(file.path);
  if (
    !finalSourceInfo.isFile || finalSourceInfo.dev !== file.dev || finalSourceInfo.ino !== file.ino
  ) throw new Error('Hardlink identity changed immediately before unlink');

  await Deno.remove(file.path);
  await pruneEmptyParents(parent(file.path), file.root);
}

export async function findRetainedSiblingPaths(
  files: readonly VerifiedOrphanFile[],
  limits: PayloadScanLimits = DEFAULT_PAYLOAD_SCAN_LIMITS,
  budget: PayloadScanBudget = { remainingEntries: limits.maxEntries },
): Promise<ArrCleanupRetainedPath[]> {
  const verified = new Set(files.map((file) => file.path));
  const boundaries = new Map(files.map((file) => [file.boundary, file.root]));
  const retained = new Map<string, ArrCleanupRetainedPath>();
  for (const [boundary, root] of boundaries) {
    if (budget.remainingEntries <= 0) {
      retained.set(boundary, {
        path: boundary,
        reason:
          `Retained-path inspection stopped after ${limits.maxEntries} entries from the shared preview budget; contents remain unverified`,
      });
      break;
    }
    try {
      if (boundary === root || !(await canonicalWithin(root, boundary))) continue;
      await lstatWithoutSymlinks(boundary);
      let entryLimitReached = false;
      const visit = async (directory: string, depth: number): Promise<void> => {
        for await (const entry of Deno.readDir(directory)) {
          if (budget.remainingEntries <= 0) {
            entryLimitReached = true;
            return;
          }
          budget.remainingEntries--;
          const path = `${directory}/${entry.name}`;
          if (verified.has(path)) continue;
          if (entry.isSymlink) {
            retained.set(path, { path, reason: 'Symbolic link is never removed automatically' });
          } else if (entry.isDirectory) {
            if (depth >= limits.maxDepth) {
              retained.set(path, {
                path,
                reason:
                  `Retained-path inspection stopped at the maximum depth of ${limits.maxDepth}; contents remain unverified`,
              });
            } else {
              await visit(path, depth + 1);
              if (entryLimitReached) return;
            }
          } else {
            retained.set(path, {
              path,
              reason: 'No current Arr-managed hardlink verifies this entry',
            });
          }
        }
      };
      await visit(boundary, 0);
      if (entryLimitReached) {
        retained.set(boundary, {
          path: boundary,
          reason:
            `Retained-path inspection stopped after ${limits.maxEntries} entries from the shared preview budget; remaining contents stay unverified`,
        });
      }
    } catch (error) {
      retained.set(boundary, {
        path: boundary,
        reason: `Retained-path inspection failed: ${
          inspectionError(error)
        }; contents remain unverified`,
      });
    }
  }
  return [...retained.values()];
}

function inspectionError(error: unknown): string {
  if (error instanceof Deno.errors.NotFound) return 'the path no longer exists';
  if (error instanceof Deno.errors.PermissionDenied) return 'permission was denied';
  return error instanceof Error ? error.message : 'filesystem inspection failed';
}

async function pruneEmptyParents(start: string, root: string): Promise<void> {
  let directory = start;
  while (directory !== root && isWithin(root, directory)) {
    const info = await Deno.lstat(directory).catch(() => null);
    if (!info || !info.isDirectory || info.isSymlink) return;
    for await (const _entry of Deno.readDir(directory)) return;
    if (!(await Deno.remove(directory).then(() => true).catch(() => false))) return;
    directory = parent(directory);
  }
}
